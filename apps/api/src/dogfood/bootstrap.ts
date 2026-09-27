import { createControlledObject } from '@kf/record-atoms';
import {
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';
import { APP_LOGIN, scramVerifier } from './config.js';
import type { DogfoodIdentity } from './contracts.js';

const BOOTSTRAP_IDENTITY = '01930000-0000-7000-8000-00000000b007';
const BOOTSTRAP_ACTION = '01930000-0000-7000-8000-00000000ac10';

/** Create or re-key the development login with this run's password. */
export async function createAppLogin(owner: Pool, password: string): Promise<string> {
  return withTransaction(owner, async (tx) => {
    const role = await tx.one<{ sql: string }>(
      `select case when exists (select from pg_roles where rolname = $1)
              then format('alter role %I login password %L inherit', $1::text, $2::text)
              else format('create role %I login password %L inherit', $1::text, $2::text)
              end as sql`,
      [APP_LOGIN, scramVerifier(password)],
    );
    await tx.query(role.sql);
    const membership = await tx.one<{ sql: string }>(
      `select format('grant kf_app to %I', $1::text) as sql`,
      [APP_LOGIN],
    );
    await tx.query(membership.sql);
    // The development API attests in-process (header identity has no token to hand to
    // kf-attestor), so its login may issue attestations. Only here: a dogfood API refuses to
    // start through a login holding kf_attestor, and this loader refuses to run on a host.
    const attests = await tx.one<{ sql: string }>(
      `select format('grant kf_attestor to %I', $1::text) as sql`,
      [APP_LOGIN],
    );
    await tx.query(attests.sql);
    const grant = await tx.one<{ sql: string }>(
      `select format('grant connect on database %I to %I', current_database(), $1::text) as sql`,
      [APP_LOGIN],
    );
    await tx.query(grant.sql);
    const database = await tx.one<{ name: string }>('select current_database() as name');
    return database.name;
  });
}

async function createPerson(tx: Tx, organizationId: string): Promise<string> {
  const id = await createControlledObject(tx, {
    objectType: 'person',
    classification: 'public',
    authorityDomain: 'organization',
    lifecycleState: 'active',
    title: 'Local Dogfood Operator',
    organizationId,
    createdBy: BOOTSTRAP_IDENTITY,
  });
  await tx.query(
    `insert into org.person (id, display_name, organization)
     values ($1, 'Local Dogfood Operator', $2)`,
    [id, organizationId],
  );
  return id;
}

async function createRole(tx: Tx, organizationId: string, actorId: string): Promise<string> {
  const id = await createControlledObject(tx, {
    objectType: 'role_assignment',
    authorityDomain: 'organization',
    lifecycleState: 'active',
    title: 'Local dogfood document performer',
    organizationId,
    createdBy: BOOTSTRAP_IDENTITY,
  });
  await tx.query(
    `insert into org.role_assignment (id, subject_id, role_id, scope_id)
     values ($1,$2,'performer',$3)`,
    [id, actorId, organizationId],
  );
  return id;
}

/**
 * Find or create the configured organization and its local operator.
 *
 * `legalName` is `KF_ORGANIZATION_LEGAL_NAME` (`requiredOrganizationLegalName`): the deploying
 * organization is configuration, never a literal here (KF-SAS-RQ-192, SAS §100.16).
 */
export async function bootstrapIdentity(owner: Pool, legalName: string): Promise<DogfoodIdentity> {
  return withTransaction(owner, async (tx) => {
    await setAccessContext(tx, {
      organizationId: BOOTSTRAP_IDENTITY,
      maxClassification: 'restricted',
    });
    await setTransactionContext(tx, {
      actorId: BOOTSTRAP_IDENTITY,
      actingRoleId: BOOTSTRAP_IDENTITY,
      actionId: BOOTSTRAP_ACTION,
      requestId: 'local-dogfood-bootstrap',
    });

    let organizationId = (
      await tx.maybeOne<{ id: string }>(
        `select o.id
           from core.object o
           join org.organization g on g.id = o.id
          where g.legal_name = $1
          order by o.created_at limit 1`,
        [legalName],
      )
    )?.id;
    if (organizationId === undefined) {
      organizationId = await createControlledObject(tx, {
        objectType: 'organization',
        classification: 'public',
        authorityDomain: 'organization',
        lifecycleState: 'active',
        title: legalName,
        organizationId: BOOTSTRAP_IDENTITY,
        createdBy: BOOTSTRAP_IDENTITY,
      });
      await tx.query(
        `update core.object
            set organization_id = $1, row_version = row_version + 1
          where id = $1`,
        [organizationId],
      );
      await tx.query(
        `insert into org.organization (id, legal_name, organization_kind)
         values ($1, $2, 'company')`,
        [organizationId, legalName],
      );
    }
    await setAccessContext(tx, { organizationId, maxClassification: 'restricted' });

    let actorId = (
      await tx.maybeOne<{ id: string }>(
        `select p.id
           from org.person p
          where p.organization = $1 and p.display_name = 'Local Dogfood Operator'
          order by p.id limit 1`,
        [organizationId],
      )
    )?.id;
    actorId ??= await createPerson(tx, organizationId);

    let actingRoleId = (
      await tx.maybeOne<{ id: string }>(
        `select id from org.role_assignment
          where subject_id = $1 and role_id = 'performer'
            and scope_id = $2 and valid_from <= now()
            and (valid_to is null or valid_to > now())
          order by valid_from limit 1`,
        [actorId, organizationId],
      )
    )?.id;
    actingRoleId ??= await createRole(tx, organizationId, actorId);
    return { organizationId, actorId, actingRoleId };
  });
}
