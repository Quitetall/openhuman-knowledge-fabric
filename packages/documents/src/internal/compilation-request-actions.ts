import type { ActionEffect, PreconditionCheck } from '@kf/actions';
import { refuseDocument } from './action-payload.js';
import { assertBasisMatchesDatabase, basisFromRequest } from './basis-validation.js';
import { assertActiveFragmentRevisions } from './composition-retirement.js';
import { touchDocumentObject } from './composition-store.js';
import { assertDocumentAuthor } from './document-authority.js';
import { COMPOSITION_TARGET, requireDocumentTarget } from './target-classification.js';

interface CompilationRequestActions {
  readonly assertRequestCompilation: PreconditionCheck;
  readonly requestDocumentCompilation: ActionEffect;
}

export function createCompilationRequestActions(): CompilationRequestActions {
  const assertRequestCompilation: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const { basis } = basisFromRequest(request);
    await assertActiveFragmentRevisions(
      tx,
      basis.fragmentRevisions.map((revision) => revision.id),
      'KF-DOC-BASIS-007',
    );
    await assertBasisMatchesDatabase(tx, basis, object.id);
  };

  const requestDocumentCompilation: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const { id, basis } = basisFromRequest(request);
    const compiler = basis.compiler;
    await tx.query(
      `insert into content.compilation_basis
         (id, protocol, root_composition_revision_id, basis, basis_digest,
          ontology_digest, policy_digest, target_profiles, compiler_kind,
          compiler_name, compiler_version, liminal_commit_sha, cargo_lock_digest,
          executable_digest, runtime_closure_digest, qualification_state,
          qualification_receipt_digest, qualification_ratified, created_by,
          created_by_action)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        id,
        basis.protocol,
        basis.rootCompositionRevisionId,
        JSON.stringify(basis),
        basis.basisDigest,
        basis.ontologyDigest,
        basis.policyDigest,
        JSON.stringify(basis.targetProfiles),
        compiler.kind,
        compiler.name,
        compiler.version,
        compiler.kind === 'liminal' ? compiler.commitSha : null,
        compiler.kind === 'liminal' ? compiler.cargoLockDigest : null,
        compiler.executableDigest,
        compiler.kind === 'liminal' ? compiler.runtimeClosureDigest : null,
        compiler.kind === 'liminal' ? compiler.qualification.state : 'not_applicable',
        compiler.kind === 'liminal' ? compiler.qualification.receiptDigest : null,
        compiler.kind === 'liminal' ? compiler.qualification.ratified : false,
        request.actorId,
        ctx.actionId,
      ],
    );
    for (const revision of basis.fragmentRevisions) {
      await tx.query(
        `insert into content.compilation_basis_fragment (basis_id, fragment_revision_id)
         values ($1,$2)`,
        [id, revision.id],
      );
    }
    for (const revision of basis.compositionRevisions) {
      await tx.query(
        `insert into content.compilation_basis_composition
           (basis_id, composition_revision_id) values ($1,$2)`,
        [id, revision.id],
      );
    }
    for (const binding of basis.bindings) {
      await tx.query(
        'insert into content.compilation_basis_binding (basis_id, binding_id) values ($1,$2)',
        [id, binding.id],
      );
    }
    const finalized = await tx.one<{ classification: string }>(
      'select content.finalize_compilation_basis($1) as classification',
      [id],
    );
    if (finalized.classification !== basis.effectiveClassification) {
      refuseDocument(
        'KF-DOC-BASIS-006',
        'database-derived Basis classification differs from the canonical Basis',
        {
          basisId: id,
          canonical: basis.effectiveClassification,
          authoritative: finalized.classification,
        },
      );
    }
    await touchDocumentObject(tx, request, object.id);
  };

  return { assertRequestCompilation, requestDocumentCompilation };
}
