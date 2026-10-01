import type { Tx } from '@kf/database';

/** Restore disables user triggers, so validate the item-to-manifest invariant explicitly. */
export async function assertMasterRecordItems(tx: Tx): Promise<void> {
  const contradictory = await tx.query(
    `select 1 from (
       select item.master_record_id, item.item_state, item.object_id::text as object_id,
              item.object_type, item.title, item.classification, item.content_digest, item.content_payload
         from content.master_record_item item
       except
       select master.id, state.name, member ->> 'objectId', member ->> 'objectType',
              coalesce(member ->> 'title', member ->> 'objectType'), member ->> 'classification',
              member ->> 'contentDigest', coalesce(member -> 'content', '{}'::jsonb)
         from content.master_record master
        cross join (values ('included'), ('withdrawn')) as state(name)
        cross join lateral jsonb_array_elements(master.manifest -> state.name) as member
     ) stray limit 1`,
  );
  if (contradictory.length > 0) {
    throw new Error(
      'refusing preservation import: master-record item contradicts its immutable manifest',
    );
  }
}
