import { taggedDigest } from '@kf/canonicalization';

/** The format an invitation token is digested under (KF-SAS-RQ-016). */
export const INVITATION_TOKEN_FORMAT = 'kf-invitation-token-v1' as const;

/**
 * The digest of an invitation link's token: the only form of it the database holds. `kf invite`
 * stores it; `GET /invitations/:token` looks the invitation up by it. One function, so the two
 * cannot disagree about what was stored.
 */
export function invitationTokenDigest(token: string): string {
  return taggedDigest(INVITATION_TOKEN_FORMAT, { token });
}
