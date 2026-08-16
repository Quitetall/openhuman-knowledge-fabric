import type { Tx } from '@kf/database';
import type { CompositionInput } from '../compiler.js';
import { refuseDocument } from './action-payload.js';

export async function fragmentRevisionClosure(
  tx: Tx,
  inputs: readonly CompositionInput[],
): Promise<string[]> {
  const direct = inputs
    .filter(
      (input): input is Extract<CompositionInput, { readonly role: 'fragment' }> =>
        input.role === 'fragment',
    )
    .map((input) => input.fragmentRevisionId);
  const childRoots = inputs
    .filter(
      (input): input is Extract<CompositionInput, { readonly role: 'composition' }> =>
        input.role === 'composition',
    )
    .map((input) => input.compositionRevisionId);
  if (childRoots.length === 0) return [...new Set(direct)].sort();
  const nested = await tx.query<{ id: string }>(
    `with recursive reachable(id) as (
       select unnest($1::uuid[])
       union
       select input.child_composition_revision_id
         from reachable parent
         join content.composition_input input on input.composition_revision_id = parent.id
        where input.child_composition_revision_id is not null
     )
     select distinct input.fragment_revision_id as id
       from reachable parent
       join content.composition_input input on input.composition_revision_id = parent.id
      where input.fragment_revision_id is not null
      order by id`,
    [childRoots],
  );
  return [...new Set([...direct, ...nested.map((row) => row.id)])].sort();
}

/**
 * Fence retirement against new composition, compilation, acceptance, and publication work.
 * Exact old revisions remain queryable as history, but a latest retired subject cannot become
 * active output again. Sorted row locks serialize this check with fragment retirement.
 */
export async function assertActiveFragmentRevisions(
  tx: Tx,
  revisionIds: readonly string[],
  rule: string,
): Promise<void> {
  const expected = [...new Set(revisionIds)].sort();
  if (expected.length === 0) return;
  await tx.query(
    `select o.id
       from content.authored_fragment_revision revision
       join content.document_subject subject on subject.id = revision.fragment_id
       join core.object o on o.id = subject.object_id
      where revision.id = any($1::uuid[])
      order by o.id, revision.id
      for share of o`,
    [expected],
  );
  const states = await tx.query<{
    id: string;
    revision_state: string;
    lifecycle_state: string;
    latest_revision_state: string;
  }>(
    `select requested.id, requested.revision_state, o.lifecycle_state,
            latest.revision_state as latest_revision_state
       from unnest($1::uuid[]) wanted(id)
       join content.authored_fragment_revision requested on requested.id = wanted.id
       join content.document_subject subject on subject.id = requested.fragment_id
       join core.object o on o.id = subject.object_id
       join lateral (
         select candidate.revision_state
           from content.authored_fragment_revision candidate
          where candidate.fragment_id = requested.fragment_id
            and not exists (
              select 1 from content.authored_fragment_revision successor
               where successor.previous_revision_id = candidate.id
            )
       ) latest on true
      order by requested.id`,
    [expected],
  );
  const invalid = states.find(
    (row) =>
      row.revision_state === 'retired' ||
      row.latest_revision_state === 'retired' ||
      row.lifecycle_state !== 'active',
  );
  if (states.length !== expected.length || invalid !== undefined) {
    refuseDocument(
      rule,
      'retired or missing fragment authority cannot contribute to active documentation',
      { revisionId: invalid?.id ?? expected.find((id) => !states.some((row) => row.id === id)) },
    );
  }
}

export async function assertActiveCompositionInputs(
  tx: Tx,
  inputs: readonly CompositionInput[],
): Promise<void> {
  await assertActiveFragmentRevisions(
    tx,
    await fragmentRevisionClosure(tx, inputs),
    'KF-DOC-COMP-004',
  );
}
