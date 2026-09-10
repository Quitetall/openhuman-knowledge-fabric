/**
 * Create an organization and its first person.
 *
 * This is a bootstrap-tier act, and it is the one genuine exception to "every controlled write
 * crosses the dispatcher". The dispatcher binds authoritative clearance before it applies
 * anything, so the FIRST clearance in an organization cannot be granted through it — there is no
 * clearance yet to bind. The organization and the person it is granted to have the same problem
 * one step earlier.
 *
 * So this writes directly, through an owner connection, and it still extends the audit chain
 * with the same arithmetic every other act uses. A chain that disagrees with itself is
 * indistinguishable from a tampered one, and "we had to bootstrap" is not an exemption from
 * that.
 *
 * It creates nothing else. No role, no clearance, no identity link: those are
 * `kf:grant-authority`, which is a human act, and collapsing them into one command would make
 * the first authority in an institution a side effect of creating it.
 */

import { createHash } from 'node:crypto';

import { appendAuditEvent } from '@kf/actions';
import {
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';
import { createControlledObject } from '@kf/record-atoms';

/** The identity every bootstrap act is attributed to, so they are findable as a class. */
const BOOTSTRAP_IDENTITY = '01930000-0000-7000-8000-00000000b007';

/**
 * Record the bootstrap act itself.
 *
 * The audit chain references `core.action`, so an act that only appended a chain entry would
 * leave the chain pointing at nothing. `action_type` is `bootstrap_organization` and it is
 * deliberately NOT in the ontology: no dispatcher can perform it, and giving it a declared type
 * would suggest one could.
 */
async function recordBootstrapAct(
  tx: Tx,
  actionId: string,
  organizationId: string,
  targets: readonly string[],
  reason: string,
): Promise<void> {
  // Milliseconds, not microseconds. The action_effective_at_canonical_wire constraint requires
  // the canonical RFC 3339 instant the dispatcher enforces, and now() carries more precision
  // than that wire format can represent.
  await tx.query(
    `insert into core.action
       (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
        target_ids, parameters, preconditions, idempotency_key, effective_at, request_id,
        reason, result_status, result)
     values ($1, $2, $3, 'bootstrap_organization', $4, $4, $5, '{}'::jsonb, '{}'::jsonb,
             $6, date_trunc('milliseconds', now()), 'bootstrap-organization', $7,
             'applied', '{}'::jsonb)`,
    [
      actionId,
      organizationId,
      createHash('sha256').update(`bootstrap-organization\u0000${reason}`).digest('hex'),
      BOOTSTRAP_IDENTITY,
      targets,
      `bootstrap-${actionId}`,
      reason,
    ],
  );
}

export interface BootstrapRequest {
  readonly legalName?: string;
  readonly personName?: string;
  readonly organizationKind?: string;
  /** Add a person to an organization that already exists, named by id. */
  readonly organizationId?: string;
}

export interface BootstrapPlan {
  readonly ok: boolean;
  readonly refusals: readonly string[];
  readonly declaration?: Required<BootstrapRequest>;
}

const ORGANIZATION_KINDS = ['company', 'customer', 'supplier', 'partner', 'regulator'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function planBootstrap(request: BootstrapRequest): BootstrapPlan {
  const refusals: string[] = [];
  const legalName = request.legalName?.trim() ?? '';
  const personName = request.personName?.trim() ?? '';
  const organizationKind = request.organizationKind?.trim() ?? 'company';

  const organizationId = request.organizationId?.trim() ?? '';
  if (legalName === '' && organizationId === '') {
    refusals.push(
      '--legal-name creates an organization; --organization <uuid> adds a person to one that ' +
        'exists. Give exactly one.',
    );
  }
  if (legalName !== '' && organizationId !== '') {
    refusals.push('--legal-name and --organization are mutually exclusive');
  }
  if (organizationId !== '' && !UUID.test(organizationId)) {
    refusals.push(`--organization must be a uuid, got ${JSON.stringify(organizationId)}`);
  }
  if (personName === '') {
    refusals.push(
      '--person is required: the first person is named, never "operator" or "admin". A record ' +
        'attributed to a placeholder is a record nobody performed.',
    );
  }
  if (!ORGANIZATION_KINDS.includes(organizationKind)) {
    refusals.push(`--kind ${organizationKind} is not one of ${ORGANIZATION_KINDS.join(', ')}`);
  }
  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    refusals: [],
    declaration: { legalName, personName, organizationKind, organizationId },
  };
}

export function parseBootstrapArgs(argv: readonly string[]): BootstrapRequest {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]!);
    if (match === null) throw new Error(`unexpected argument ${argv[i]!}`);
    const name = match[1]!;
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === '') throw new Error(`--${name} needs a value`);
    values[name] = value;
  }
  const known = new Set(['legal-name', 'person', 'kind', 'organization']);
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error(`unknown option --${key}`);
  }
  return {
    ...(values['legal-name'] === undefined ? {} : { legalName: values['legal-name'] }),
    ...(values['person'] === undefined ? {} : { personName: values['person'] }),
    ...(values['kind'] === undefined ? {} : { organizationKind: values['kind'] }),
    ...(values['organization'] === undefined ? {} : { organizationId: values['organization'] }),
  };
}

export interface BootstrapResult {
  readonly organizationId: string;
  readonly personId: string;
  readonly reused: boolean;
}

export async function runBootstrap(
  owner: Pool,
  declaration: Required<BootstrapRequest>,
): Promise<BootstrapResult> {
  return withTransaction(owner, async (tx: Tx) => {
    await setAccessContext(tx, {
      organizationId: BOOTSTRAP_IDENTITY,
      maxClassification: 'restricted',
    });
    const actionId = (await tx.one<{ id: string }>('select uuidv7() as id')).id;
    await setTransactionContext(tx, {
      actorId: BOOTSTRAP_IDENTITY,
      actingRoleId: BOOTSTRAP_IDENTITY,
      actionId,
      requestId: 'bootstrap-organization',
    });

    // NAMED BY ID, never looked up by legal name.
    //
    // The first version searched for an existing organization by name, and could never find one:
    // the query joins `core.object`, whose row-level security scopes every row to the bound
    // organization, and a bootstrap context is not that organization. It silently created a
    // second company each time it ran — eight of them, before anything noticed. The same rule
    // that makes the self-referential insert work makes the lookup blind, and a lookup that
    // cannot fail loudly is worse than no lookup.
    const existing =
      declaration.organizationId === ''
        ? undefined
        : await (async () => {
            await setAccessContext(tx, {
              organizationId: declaration.organizationId,
              maxClassification: 'restricted',
            });
            const row = await tx.maybeOne<{ id: string }>(
              `select id from core.object where id = $1 and object_type = 'organization'`,
              [declaration.organizationId],
            );
            if (row === undefined) {
              throw new Error(
                `no organization ${declaration.organizationId} is visible; check the id`,
              );
            }
            return row;
          })();

    if (existing !== undefined) {
      await setAccessContext(tx, {
        organizationId: existing.id,
        maxClassification: 'restricted',
      });
      const person = await tx.maybeOne<{ id: string }>(
        `select id from org.person where organization = $1 and display_name = $2 limit 1`,
        [existing.id, declaration.personName],
      );
      if (person !== undefined) {
        return { organizationId: existing.id, personId: person.id, reused: true };
      }
      const personId = await createControlledObject(tx, {
        objectType: 'person',
        authorityDomain: 'organization',
        lifecycleState: 'active',
        title: declaration.personName,
        organizationId: existing.id,
        createdBy: BOOTSTRAP_IDENTITY,
      });
      await tx.query(
        `insert into org.person (id, display_name, organization) values ($1, $2, $3)`,
        [personId, declaration.personName, existing.id],
      );
      const personReason = `first person ${declaration.personName} in ${declaration.legalName}`;
      await recordBootstrapAct(tx, actionId, existing.id, [personId], personReason);
      await appendAuditEvent(tx, {
        actionId,
        actionType: 'bootstrap_organization',
        actorId: BOOTSTRAP_IDENTITY,
        actingRoleId: BOOTSTRAP_IDENTITY,
        objectIds: [personId],
        effectiveAt: new Date(),
        requestId: 'bootstrap-organization',
        reason: `first person ${declaration.personName} in ${declaration.legalName}`,
        beforeDigest: null,
        afterDigest: null,
      });
      return { organizationId: existing.id, personId, reused: false };
    }

    // An organization belongs to ITSELF, and that is why this one insert is written by hand
    // rather than through `createControlledObject`.
    //
    // The row-level security check on `core.object` requires `organization_id =
    // core.current_organization()`. Creating the row under a bootstrap organization and then
    // re-pointing it at itself cannot pass that check in either direction: before the update the
    // new value is not the current organization, and after it the old row is invisible. The id
    // has to exist before the row does, so the context can be bound to it and the insert can
    // satisfy the policy on its first attempt.
    const organizationId = (await tx.one<{ id: string }>('select uuidv7() as id')).id;
    await setAccessContext(tx, { organizationId, maxClassification: 'restricted' });
    const { version } = await tx.one<{ version: string }>(
      'select version from registry.schema_release where is_current',
    );
    await tx.query(
      `insert into core.object
         (id, object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ($1, 'organization', 'organization', 'active', 'internal', 'project_record',
               $2, $1, $3, $4, $4)`,
      [organizationId, version, declaration.legalName, BOOTSTRAP_IDENTITY],
    );
    await tx.query(
      `insert into org.organization (id, legal_name, organization_kind) values ($1, $2, $3)`,
      [organizationId, declaration.legalName, declaration.organizationKind],
    );

    const personId = await createControlledObject(tx, {
      objectType: 'person',
      authorityDomain: 'organization',
      lifecycleState: 'active',
      title: declaration.personName,
      organizationId,
      createdBy: BOOTSTRAP_IDENTITY,
    });
    await tx.query(`insert into org.person (id, display_name, organization) values ($1, $2, $3)`, [
      personId,
      declaration.personName,
      organizationId,
    ]);

    const reason = `bootstrap ${declaration.legalName} with first person ${declaration.personName}`;
    await recordBootstrapAct(tx, actionId, organizationId, [organizationId, personId], reason);
    await appendAuditEvent(tx, {
      actionId,
      actionType: 'bootstrap_organization',
      actorId: BOOTSTRAP_IDENTITY,
      actingRoleId: BOOTSTRAP_IDENTITY,
      objectIds: [organizationId, personId],
      effectiveAt: new Date(),
      requestId: 'bootstrap-organization',
      reason: `bootstrap ${declaration.legalName} with first person ${declaration.personName}`,
      beforeDigest: null,
      afterDigest: null,
    });

    return { organizationId, personId, reused: false };
  });
}

export function bootstrapUsage(): string {
  return [
    'kf bootstrap-organization — create an organization and its first person',
    '',
    '  kf bootstrap-organization --legal-name "Munder Diffin Paper Shredding" \\',
    '      --person "Jim Miller" [--kind company]',
    '',
    'Needs DATABASE_OWNER_URL: this writes authority and the dispatcher cannot, because the',
    'first clearance in an organization has no clearance to bind. It creates the organization',
    'and the person and nothing else — the role, the clearance and the identity link are',
    '`kf:grant-authority`, which is a human act.',
  ].join('\n');
}
