import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ApiError } from '../../../lib/api';
import { getInvitation } from '../../../lib/api/qualification';
import { webCaller } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your invitation' };

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * `/join/<token>` — where an invitation link leads (ADR 0040 decision 12; KF-SAS-RQ-275).
 *
 * The link carries no authority. Signing in is the identity provider's (the account the owner
 * created and linked); the API then answers the token only for that signed-in person, and this
 * page sends them to Start Here. For anyone else, and for any other token, it says so and nothing
 * more: it does not reveal whether an invitation exists.
 */
export default async function JoinPage({
  params,
}: {
  readonly params: Promise<{ readonly token: string }>;
}) {
  const { token } = await params;
  const valid = TOKEN.test(token);
  const caller = await webCaller(valid ? `/join/${token}` : '/');
  let next: string | undefined;
  let expired = false;
  if (valid) {
    try {
      const answer = await getInvitation(caller, token);
      expired = answer.expired;
      next = answer.next;
    } catch (error: unknown) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  if (next !== undefined && !expired) redirect(next);
  return (
    <main className="kf-page kf-page-narrow">
      <h1 className="kf-title">Your invitation</h1>
      {next !== undefined && expired ? (
        <p>
          This invitation has expired. You are signed in, so you can go straight to{' '}
          <Link href="/start-here">Start Here</Link>; ask your contact if anything is missing.
        </p>
      ) : (
        <p>
          This link is not an invitation for the account you are signed in with. If you were sent
          it, sign out and sign in with the account it was sent to.
        </p>
      )}
    </main>
  );
}
