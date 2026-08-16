import type { ActionEffect, PreconditionCheck } from '@kf/actions';
import { assertAuthorizedCompilationRun } from './compilation-authorization.js';
import { touchDocumentObject } from './composition-store.js';
import { assertTechnicalDocumentAuthority } from './document-authority.js';
import { COMPOSITION_TARGET, requireDocumentTarget } from './target-classification.js';

interface CompilationAcceptActions {
  readonly assertAcceptCompilation: PreconditionCheck;
  readonly acceptDocumentCompilation: ActionEffect;
}

export function createCompilationAcceptActions(): CompilationAcceptActions {
  const assertAcceptCompilation: PreconditionCheck = async (tx, request, objects) => {
    await assertTechnicalDocumentAuthority(tx, request, objects);
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    await assertAuthorizedCompilationRun(tx, request, object);
  };

  const acceptDocumentCompilation: ActionEffect = async (tx, request, objects) => {
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    await touchDocumentObject(tx, request, object.id);
  };

  return { assertAcceptCompilation, acceptDocumentCompilation };
}
