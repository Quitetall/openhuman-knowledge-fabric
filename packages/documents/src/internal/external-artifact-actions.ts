/**
 * Registering an artifact whose bytes we do NOT hold.
 *
 * `attach_evidence` hardcodes `source_system='object_store'` and requires a `storage_uri`, so
 * until now the only way anything could enter KF was by copying its bytes. That is the wrong
 * and sometimes forbidden answer for third-party material: a vendor datasheet is somebody
 * else's copyright, and the standing rule is that it is referenced by document number,
 * revision and hash — never held.
 *
 * This is deliberately a SEPARATE action rather than a widened `attach_evidence`. The name of
 * an action is what an auditor reads. "We attached this evidence" and "we recorded that this
 * exists elsewhere" are different claims about what the organization possesses, and collapsing
 * them into one verb would make the audit log unable to answer "do we actually have this?".
 *
 * The database already anticipated this shape and enforces the important half:
 *
 *   artifact_version_locatable  CHECK (storage_uri IS NOT NULL OR revision_label IS NOT NULL)
 *
 * A version must be locatable. Either we hold the bytes, or we can say which revision we saw.
 * So a reference without a revision label is refused by PostgreSQL, not by politeness — you
 * cannot record that a thing exists elsewhere without being able to name which thing.
 */

import type { ActionEffect, ActionMaterializer } from '@kf/actions';
import {
  createControlledObject,
  optionalString,
  requireInteger,
  requireString,
} from '@kf/record-atoms';
import { requireSha256 } from './action-types.js';

/**
 * `object_store` means we hold the bytes, which is what `attach_evidence` is for. Every other
 * value means somebody else holds them and can change them underneath us — which is exactly
 * why the digest is recorded alongside.
 */
const EXTERNAL_SOURCE_SYSTEMS = new Set([
  'git',
  'cad_pdm',
  'document_system',
  'accounting',
  'external',
]);

/** Why we hold the reference. A mirror must never be mistaken for the authoritative copy. */
const LOCATOR_AUTHORITIES = new Set(['authoritative', 'evidence', 'mirror', 'lookup']);

interface ExternalArtifactActions {
  readonly registerExternalArtifact: ActionMaterializer;
  readonly recordExternalArtifact: ActionEffect;
}

export function createExternalArtifactActions(): ExternalArtifactActions {
  const registerExternalArtifact: ActionMaterializer = async (tx, request) => {
    if (request.targetIds.length > 0) return [];

    const sourceSystem = requireString(request.payload, 'source_system');
    if (sourceSystem === 'object_store') {
      throw new Error(
        'register_external_artifact cannot claim source_system=object_store: that asserts we ' +
          'hold the bytes, which is attach_evidence. Use that action, or name the system that ' +
          'actually holds them.',
      );
    }
    if (!EXTERNAL_SOURCE_SYSTEMS.has(sourceSystem)) {
      throw new Error(`unknown external source_system: ${sourceSystem}`);
    }

    const id = await createControlledObject(tx, {
      objectType: 'artifact',
      authorityDomain: 'artifact',
      lifecycleState: 'draft',
      title: requireString(request.payload, 'title'),
      organizationId: request.organizationId,
      createdBy: request.actorId,
      retentionClass: 'quality_record',
    });
    await tx.query(
      `insert into content.artifact (id, artifact_kind, source_system) values ($1,$2,$3)`,
      [id, requireString(request.payload, 'artifact_kind'), sourceSystem],
    );
    return [id];
  };

  const recordExternalArtifact: ActionEffect = async (tx, request, objects, ctx) => {
    const artifact = objects.find((object) => object.object_type === 'artifact');
    if (artifact === undefined) {
      throw new Error('register_external_artifact created no artifact target');
    }

    // Required here as well as by the CHECK constraint, so the refusal names the reason rather
    // than surfacing a constraint violation the caller has to decode.
    const revisionLabel = requireString(request.payload, 'revision_label');
    const authority = requireString(request.payload, 'authority');
    if (!LOCATOR_AUTHORITIES.has(authority)) {
      throw new Error(`unknown locator authority: ${authority}`);
    }

    const { next } = await tx.one<{ next: number }>('select content.next_version_no($1) as next', [
      artifact.id,
    ]);
    // storage_uri and storage_version stay NULL on purpose: this row asserts that bytes with
    // this digest existed somewhere else, not that we can produce them.
    const version = await tx.one<{ id: string }>(
      `insert into content.artifact_version
         (artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
          created_by, created_by_action)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id`,
      [
        artifact.id,
        next,
        revisionLabel,
        requireSha256(request.payload),
        requireInteger(request.payload, 'size_bytes'),
        requireString(request.payload, 'media_type'),
        request.actorId,
        ctx.actionId,
      ],
    );

    const uri = optionalString(request.payload, 'uri');
    await tx.query(
      `insert into content.external_locator (version_id, system, external_id, uri, authority)
       values ($1,$2,$3,$4,$5)`,
      [
        version.id,
        requireString(request.payload, 'locator_system'),
        requireString(request.payload, 'external_id'),
        uri,
        authority,
      ],
    );
  };

  return { registerExternalArtifact, recordExternalArtifact };
}
