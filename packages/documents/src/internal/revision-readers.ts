import type { Tx } from '@kf/database';

export const latestFragmentRevision = async (
  tx: Tx,
  objectId: string,
): Promise<{ subject_id: string; revision_id: string; revision_state: string } | undefined> =>
  tx.maybeOne<{ subject_id: string; revision_id: string; revision_state: string }>(
    `select s.id as subject_id, r.id as revision_id, r.revision_state
       from content.document_subject s
       join content.authored_fragment_revision r on r.fragment_id = s.id
      where s.object_id = $1
        and not exists (
          select 1 from content.authored_fragment_revision next
           where next.previous_revision_id = r.id
        )`,
    [objectId],
  );

export const latestCompositionRevision = async (
  tx: Tx,
  objectId: string,
): Promise<{ subject_id: string; revision_id: string } | undefined> =>
  tx.maybeOne<{ subject_id: string; revision_id: string }>(
    `select s.id as subject_id, r.id as revision_id
       from content.document_subject s
       join content.composition_revision r on r.composition_id = s.id
      where s.object_id = $1
        and not exists (
          select 1 from content.composition_revision next
           where next.previous_revision_id = r.id
        )`,
    [objectId],
  );
