import { runMigrations } from 'graphile-worker';
import { withTransaction, type Pool } from '@kf/database';

/**
 * Initialize the library-owned queue and provision its read-only backup access.
 *
 * Call as the ordinary queue owner before starting runners, or once before a KF
 * upgrade on an already running host. Refuses unexpected ownership, definer
 * functions, restrictive backup policies and existing backup write privileges.
 * Does not transfer ownership, grant role membership, change RLS flags or run KF
 * migrations. Repeated calls reconcile new library-owned tables atomically.
 */
export async function prepareWorkerQueue(pool: Pool): Promise<void> {
  try {
    await withTransaction(pool, async (tx) => {
      const identity = await tx.one<{ admitted: boolean }>(`
        select not r.rolsuper and not r.rolbypassrls
          and exists(select from pg_roles b where b.rolname='kf_backup'
                     and not b.rolsuper and not b.rolbypassrls)
          and not exists(select from pg_namespace n where n.nspname='graphile_worker'
                         and n.nspowner <> r.oid) as admitted
        from pg_roles r where r.rolname=current_user`);
      if (!identity.admitted) throw new Error('worker_queue_backup_refused');
    });
    await runMigrations({ pgPool: pool });
    await withTransaction(pool, (tx) =>
      tx.query(`
      select pg_advisory_xact_lock(hashtextextended('kf.worker-queue-backup',0));
      do $$
      declare
        v_schema oid;
        v_owner oid;
        v_backup oid := 'kf_backup'::regrole;
        v_table record;
      begin
        select oid,nspowner into strict v_schema,v_owner
          from pg_namespace where nspname='graphile_worker';
        if v_owner <> current_user::regrole
          or pg_has_role(v_backup,v_owner,'member')
          or has_schema_privilege(v_backup,v_schema,'create')
          or exists(select from pg_class c where c.relnamespace=v_schema
                    and c.relkind in ('r','p','v','m','S') and c.relowner<>v_owner)
          or exists(select from pg_proc p where p.pronamespace=v_schema
                    and (p.proowner<>v_owner or p.prosecdef))
          or exists(select from pg_class c where c.relnamespace=v_schema
                    and c.relrowsecurity and c.relforcerowsecurity)
          or exists(select from pg_class c where c.relnamespace=v_schema
                    and case when c.relkind='S' then
                      has_sequence_privilege(v_backup,c.oid,'usage,update')
                    when c.relkind in ('r','p','v','m') then
                      has_table_privilege(v_backup,c.oid,'insert,update,delete,truncate,references,trigger,maintain')
                      or has_any_column_privilege(v_backup,c.oid,'insert,update,references')
                    else false end)
          or exists(select from pg_policy p join pg_class c on c.oid=p.polrelid
                    where c.relnamespace=v_schema and p.polcmd in ('r','*')
                    and not p.polpermissive and exists(
                      select from unnest(p.polroles) role_id where
                        case when role_id=0 then true else pg_has_role(v_backup,role_id,'usage') end))
        then
          raise exception 'worker_queue_backup_refused';
        end if;
        -- The library's functions are invokers: these SELECT grants cannot make
        -- add_job or a sequence increment into a backup-role write capability.
        grant usage on schema graphile_worker to kf_backup;
        grant select on all tables in schema graphile_worker to kf_backup;
        grant select on all sequences in schema graphile_worker to kf_backup;
        for v_table in select c.oid,c.relname from pg_class c
          where c.relnamespace=v_schema and c.relkind in ('r','p') and c.relrowsecurity
        loop
          if exists(select from pg_policy p where p.polrelid=v_table.oid
                    and p.polname='kf_backup_read') then
            if not exists(select from pg_policy p where p.polrelid=v_table.oid
                          and p.polname='kf_backup_read' and p.polpermissive
                          and p.polcmd='r' and p.polroles=array[v_backup]
                          and pg_get_expr(p.polqual,p.polrelid)='true'
                          and p.polwithcheck is null) then
              raise exception 'worker_queue_backup_refused';
            end if;
          else
            execute format('create policy kf_backup_read on graphile_worker.%I for select to kf_backup using (true)',v_table.relname);
          end if;
        end loop;
      end $$;
    `),
    );
  } catch {
    // Never attach the provider error, connection string or arbitrary SQL text.
    throw new Error('worker_queue_backup_refused');
  }
}
