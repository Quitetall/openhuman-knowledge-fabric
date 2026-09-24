/**
 * Declare an agent client — or withdraw one — over the owner credential (ADR 0035).
 *
 * An agent acts for a named person on a token it obtained by token exchange, and kf-attestor
 * accepts such a token only when the client it names is a live row in `org.declared_agent`
 * (`core.issue_attestation` refuses any other). Which clients may take part is a decision this
 * system records, not something a realm administrator can grant by switching on token exchange:
 * the same reason role claims are never read.
 *
 * WHY THE ROW IS THE RECORD, AND NOT AN ACT. Declaring an agent targets no record and belongs to
 * no organization — one agent client may act for people in any of them — so there is nothing for a
 * ledger row to target or an organization for it to sit in. The declaration row carries its own
 * record instead: the deciding person, their reason, the owner login and the time; rows are never
 * deleted, and a withdrawal (with its own decider, reason, login and time) is the only change a row
 * accepts. The database enforces both (`declared_agent_is_append_only`).
 *
 * The decider must be a human person holding a live role assignment somewhere: a declaration by
 * nobody, or by a service actor, is refused.
 */

import { setAccessContext, withTransaction, type Pool, type Tx } from '@kf/database';

export interface DeclareAgentRequest {
  readonly clientId?: string;
  readonly declaredBy?: string;
  readonly reason?: string;
  readonly withdraw?: boolean;
}

export interface DeclareAgentDecision {
  readonly clientId: string;
  readonly declaredBy: string;
  readonly reason: string;
  readonly withdraw: boolean;
}

export type DeclareAgentPlan =
  | { readonly ok: true; readonly decision: DeclareAgentDecision }
  | { readonly ok: false; readonly refusals: readonly string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The database's own check on `org.declared_agent.client_id`, so a refusal comes first here. */
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

export function declareAgentUsage(): string {
  return [
    'kf declare-agent --client <client id> --declared-by <person uuid> --reason <text>',
    'kf declare-agent --withdraw --client <client id> --declared-by <person uuid> --reason <text>',
  ].join('\n');
}

/** Validate a declaration without touching a database; every refusal at once. */
export function planDeclareAgent(request: DeclareAgentRequest): DeclareAgentPlan {
  const refusals: string[] = [];
  const clientId = request.clientId?.trim() ?? '';
  const declaredBy = request.declaredBy?.trim() ?? '';
  const reason = request.reason?.trim() ?? '';
  if (clientId === '') {
    refusals.push('no --client given: the OAuth client id of the agent, as the realm names it');
  } else if (!CLIENT_ID.test(clientId)) {
    refusals.push(`--client is not a client id, got ${JSON.stringify(clientId)}`);
  }
  if (declaredBy === '') {
    refusals.push('no --declared-by given: who decided this. A declaration by nobody is not one');
  } else if (!UUID.test(declaredBy)) {
    refusals.push(`--declared-by must be a person's uuid, got ${JSON.stringify(declaredBy)}`);
  }
  if (reason.length < 8) {
    refusals.push(
      'no --reason given (eight characters or more). The record has to say why this client may ' +
        (request.withdraw === true ? 'no longer act for people' : 'act for people'),
    );
  }
  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    decision: { clientId, declaredBy, reason, withdraw: request.withdraw === true },
  };
}

/** `--flag value`, `--flag=value` and the bare `--withdraw`; unknown flags are refused. */
export function parseDeclareAgentArgs(argv: readonly string[]): DeclareAgentRequest {
  const known = new Map<string, 'clientId' | 'declaredBy' | 'reason'>([
    ['--client', 'clientId'],
    ['--declared-by', 'declaredBy'],
    ['--reason', 'reason'],
  ]);
  const out: { clientId?: string; declaredBy?: string; reason?: string; withdraw?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--withdraw') {
      out.withdraw = true;
      continue;
    }
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const key = known.get(flag);
    if (key === undefined) {
      throw new Error(
        `unknown flag ${flag}; expected one of ${[...known.keys(), '--withdraw'].join(', ')}`,
      );
    }
    if (eq !== -1) {
      out[key] = token.slice(eq + 1);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    out[key] = value;
    index += 1;
  }
  return out;
}

export interface DeclareAgentResult {
  readonly clientId: string;
  readonly declaredAt: Date;
  readonly withdrawnAt?: Date;
  /** True when the client was already declared and live: nothing was written. */
  readonly unchanged: boolean;
}

async function requireDecider(tx: Tx, personId: string): Promise<void> {
  const person = await tx.maybeOne<{ organization: string; person_kind: string }>(
    'select organization, person_kind from org.person where id = $1',
    [personId],
  );
  if (person === undefined) throw new Error(`--declared-by ${personId} is not a person`);
  if (person.person_kind !== 'human') {
    throw new Error('--declared-by is a service actor; a person decides which agents may act');
  }
  await setAccessContext(tx, {
    organizationId: person.organization,
    maxClassification: 'restricted',
  });
  const role = await tx.maybeOne<{ id: string }>(
    `select id from org.role_assignment
      where subject_id = $1
        and valid_from <= now() and (valid_to is null or valid_to > now())
      limit 1`,
    [personId],
  );
  if (role === undefined) {
    throw new Error('--declared-by holds no live role assignment; nobody exercised authority');
  }
}

type DeclaredRow = {
  readonly declared_at: Date;
  readonly withdrawn_at: Date | null;
};

export async function runDeclareAgent(
  owner: Pool,
  decision: DeclareAgentDecision,
): Promise<DeclareAgentResult> {
  return withTransaction(owner, async (tx: Tx) => {
    await requireDecider(tx, decision.declaredBy);
    // FOR UPDATE: two operators declaring or withdrawing the same client at once record one.
    const existing = await tx.maybeOne<DeclaredRow>(
      'select declared_at, withdrawn_at from org.declared_agent where client_id = $1 for update',
      [decision.clientId],
    );

    if (decision.withdraw) {
      if (existing === undefined) {
        throw new Error(`client ${decision.clientId} was never declared; nothing to withdraw`);
      }
      if (existing.withdrawn_at !== null) {
        throw new Error(
          `client ${decision.clientId} was already withdrawn at ` +
            `${existing.withdrawn_at.toISOString()}. Nothing was written.`,
        );
      }
      // The trigger stamps withdrawn_at and withdrawn_login from the database's clock and session.
      const row = await tx.one<{ withdrawn_at: Date }>(
        `update org.declared_agent
            set withdrawn_at = now(), withdrawn_by = $2, withdrawn_reason = $3,
                withdrawn_login = session_user
          where client_id = $1
        returning withdrawn_at`,
        [decision.clientId, decision.declaredBy, decision.reason],
      );
      return {
        clientId: decision.clientId,
        declaredAt: existing.declared_at,
        withdrawnAt: row.withdrawn_at,
        unchanged: false,
      };
    }

    if (existing !== undefined) {
      if (existing.withdrawn_at === null) {
        return { clientId: decision.clientId, declaredAt: existing.declared_at, unchanged: true };
      }
      // A withdrawn declaration is history; reviving it under the same row would rewrite it.
      throw new Error(
        `client ${decision.clientId} was withdrawn at ${existing.withdrawn_at.toISOString()}; ` +
          'a withdrawn agent is not re-declared under the same client id. Register a new client.',
      );
    }
    const row = await tx.one<{ declared_at: Date }>(
      `insert into org.declared_agent (client_id, declared_by, reason)
       values ($1, $2, $3) returning declared_at`,
      [decision.clientId, decision.declaredBy, decision.reason],
    );
    return { clientId: decision.clientId, declaredAt: row.declared_at, unchanged: false };
  });
}
