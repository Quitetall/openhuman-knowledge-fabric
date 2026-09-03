import type { ActionEffect, ActionMaterializer } from '@kf/actions';
import { recordVersion, verifyUpload, type ObjectStore, type VerifiedUpload } from '@kf/artifacts';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import {
  createControlledObject,
  optionalString,
  requireInteger,
  requireString,
} from '@kf/record-atoms';
import {
  DocumentParseIntegrityError,
  validateParsedDocument,
  type DocumentParser,
} from './parse-contract.js';
import { requireSha256 } from './action-types.js';

interface EvidenceActions {
  readonly attachEvidence: ActionMaterializer;
  readonly recordEvidence: ActionEffect;
}

export function createEvidenceActions(options: {
  readonly store: ObjectStore;
  readonly parser: DocumentParser;
}): EvidenceActions {
  const attachEvidence: ActionMaterializer = async (tx, request) => {
    if (request.targetIds.length > 0) return [];
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
      `insert into content.artifact (id, artifact_kind, source_system) values ($1,$2,'object_store')`,
      [id, requireString(request.payload, 'artifact_kind')],
    );
    return [id];
  };

  const recordEvidence: ActionEffect = async (tx, request, objects, ctx) => {
    const artifact = objects.find((object) => object.object_type === 'artifact');
    if (artifact === undefined) throw new Error('attach_evidence created no artifact target');
    const key = requireString(request.payload, 'storage_uri');
    const mediaType = requireString(request.payload, 'media_type');
    const verified: VerifiedUpload = await verifyUpload(options.store, {
      key,
      claimedSha256: requireSha256(request.payload),
      claimedSizeBytes: requireInteger(request.payload, 'size_bytes'),
    });
    const revisionLabel = optionalString(request.payload, 'revision_label');
    const version = await recordVersion(tx, {
      artifactId: artifact.id,
      verified,
      mediaType,
      createdBy: request.actorId,
      createdByAction: ctx.actionId,
      ...(revisionLabel === null ? {} : { revisionLabel }),
    });

    // ADR 0022: a copy of something whose authority is elsewhere records where, at which
    // revision. Optional; when present it is a locator row like register_external_artifact's.
    const locator = request.payload?.['source_locator'];
    if (locator !== undefined) {
      if (typeof locator !== 'object' || locator === null || Array.isArray(locator)) {
        throw new Error('source_locator must be an object');
      }
      const l = locator as Record<string, unknown>;
      const system = requireString(l, 'system');
      const externalId = requireString(l, 'external_id');
      const authority = requireString(l, 'authority');
      if (!['authoritative', 'evidence', 'mirror', 'lookup'].includes(authority)) {
        throw new Error(
          'source_locator.authority must be authoritative | evidence | mirror | lookup',
        );
      }
      await tx.query(
        `insert into content.external_locator (version_id, system, external_id, uri, authority, synced_at)
         values ($1, $2, $3, $4, $5, now())`,
        [version.id, system, externalId, optionalString(l, 'uri'), authority],
      );
    }

    const sourceBytes = await options.store.read(
      verified.key,
      verified.storageVersion,
      verified.sizeBytes,
    );
    if (sourceBytes.length !== verified.sizeBytes || digestBytes(sourceBytes) !== verified.sha256) {
      throw new DocumentParseIntegrityError(
        'source bytes changed between artifact verification and parser persistence',
      );
    }
    const parserResult = await options.parser.parse(sourceBytes, mediaType);
    if (parserResult === undefined) return;
    const parsed = validateParsedDocument(parserResult, sourceBytes);
    const atomClaims = parsed.atoms.map(({ digest: _digest, ...claim }) => claim);
    const lossPreimage = canonicalize(parsed.conversionLoss);
    const projectionPreimage = canonicalize({
      projectionContract: parsed.projectionContract,
      atoms: atomClaims,
      conversionLoss: parsed.conversionLoss,
    });
    const parse = await tx.one<{ id: string }>(
      `insert into content.document_parse
         (artifact_version_id, parser, parser_version, projection_contract, conversion_loss,
          source_digest, loss_digest, loss_preimage, projection_preimage,
          content_digest, created_by, created_by_action)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning id`,
      [
        version.id,
        parsed.parser,
        parsed.parserVersion,
        parsed.projectionContract,
        JSON.stringify(parsed.conversionLoss),
        parsed.sourceDigest,
        parsed.lossDigest,
        lossPreimage,
        projectionPreimage,
        parsed.contentDigest,
        request.actorId,
        ctx.actionId,
      ],
    );
    for (const atom of parsed.atoms) {
      await tx.query(
        `insert into content.document_atom
           (parse_id, ordinal, atom_kind, heading_level, text_content, attributes, atom_digest,
            atom_preimage)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          parse.id,
          atom.ordinal,
          atom.kind,
          atom.level,
          atom.text,
          JSON.stringify(atom.attributes),
          atom.digest,
          canonicalize({
            ordinal: atom.ordinal,
            kind: atom.kind,
            level: atom.level,
            text: atom.text,
            attributes: atom.attributes,
          }),
        ],
      );
    }
  };

  return { attachEvidence, recordEvidence };
}
