import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { digestBytes } from '@kf/canonicalization';
import type { Tx } from '@kf/database';

export interface MasterRecordLinkClaims {
  readonly linkId: string;
  readonly masterRecordId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope: Readonly<Record<string, unknown>>;
}

export interface IssuedMasterRecordLink {
  readonly id: string;
  readonly token: string;
  readonly tokenDigest: string;
  readonly claims: MasterRecordLinkClaims;
}

export async function revokeMasterRecordLink(
  tx: Tx,
  options: {
    readonly linkId: string;
    readonly revokedBy: string;
    readonly revokedByAction: string;
    readonly reason: string;
  },
): Promise<void> {
  if (options.reason.trim() === '') throw new Error('master-record link revocation needs a reason');
  await tx.query(
    `insert into content.master_record_link_revocation
       (link_id, revoked_by, revoked_by_action, reason)
     values ($1,$2,$3,$4)`,
    [options.linkId, options.revokedBy, options.revokedByAction, options.reason],
  );
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function sign(secret: string, payload: string): string {
  return base64url(createHmac('sha256', secret).update(payload, 'utf8').digest());
}

function payload(claims: MasterRecordLinkClaims): string {
  return base64url(Buffer.from(JSON.stringify(claims), 'utf8'));
}

function tokenDigest(token: string): string {
  return digestBytes(Buffer.from(token, 'utf8'));
}

/** Create a signed, expiring token and persist only its digest and scope. */
export async function issueMasterRecordLink(
  tx: Tx,
  options: {
    readonly secret: string;
    readonly masterRecordId: string;
    readonly issuedBy: string;
    readonly issuedByAction: string;
    readonly expiresAt: string;
    readonly scope?: Readonly<Record<string, unknown>>;
    readonly issuedAt?: string;
  },
): Promise<IssuedMasterRecordLink> {
  if (Buffer.byteLength(options.secret, 'utf8') < 32)
    throw new Error('master-record link secret must be at least 32 bytes');
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  const claims: MasterRecordLinkClaims = {
    linkId: randomUUID(),
    masterRecordId: options.masterRecordId,
    issuedAt,
    expiresAt: options.expiresAt,
    scope: options.scope ?? { kind: 'master_record' },
  };
  if (!Number.isFinite(Date.parse(issuedAt)) || !Number.isFinite(Date.parse(options.expiresAt))) {
    throw new Error('master-record link timestamps must be valid instants');
  }
  if (Date.parse(options.expiresAt) <= Date.parse(issuedAt)) {
    throw new Error('master-record link expiresAt must be after issuedAt');
  }
  const encoded = payload(claims);
  const token = `${encoded}.${sign(options.secret, encoded)}`;
  const digest = tokenDigest(token);
  await tx.query(
    `insert into content.master_record_link
       (id, master_record_id, token_digest, scope, issued_at, expires_at, issued_by, issued_by_action)
     values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
    [
      claims.linkId,
      options.masterRecordId,
      digest,
      JSON.stringify(claims.scope),
      issuedAt,
      options.expiresAt,
      options.issuedBy,
      options.issuedByAction,
    ],
  );
  await tx.query(
    `insert into core.outbox (action_id, topic, payload)
     values ($1, 'kf.master_record_link_issued', $2::jsonb)`,
    [
      options.issuedByAction,
      JSON.stringify({
        link_id: claims.linkId,
        action_id: options.issuedByAction,
        token_digest: digest,
        payload_digest: digestBytes(Buffer.from(JSON.stringify(claims.scope), 'utf8')),
      }),
    ],
  );
  return { id: claims.linkId, token, tokenDigest: digest, claims };
}

/** Verify token signature and canonical claim shape before any database lookup. */
export function verifyMasterRecordLinkToken(
  token: string,
  secret: string,
): MasterRecordLinkClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const [encoded, received] = parts;
  if (!encoded || !received) return undefined;
  const expected = sign(secret, encoded);
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  if (
    expectedBytes.length !== receivedBytes.length ||
    !timingSafeEqual(expectedBytes, receivedBytes)
  ) {
    return undefined;
  }
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof raw['linkId'] !== 'string' ||
      typeof raw['masterRecordId'] !== 'string' ||
      typeof raw['issuedAt'] !== 'string' ||
      typeof raw['expiresAt'] !== 'string' ||
      typeof raw['scope'] !== 'object' ||
      raw['scope'] === null ||
      Array.isArray(raw['scope'])
    )
      return undefined;
    if (new Date(raw['issuedAt']).toISOString() !== raw['issuedAt']) return undefined;
    if (new Date(raw['expiresAt']).toISOString() !== raw['expiresAt']) return undefined;
    return {
      linkId: raw['linkId'],
      masterRecordId: raw['masterRecordId'],
      issuedAt: raw['issuedAt'],
      expiresAt: raw['expiresAt'],
      scope: raw['scope'] as Readonly<Record<string, unknown>>,
    };
  } catch {
    return undefined;
  }
}
