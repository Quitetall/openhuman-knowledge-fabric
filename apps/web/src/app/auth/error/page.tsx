import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign-in refused' };

const MESSAGES: Readonly<Record<string, string>> = {
  provider_unavailable: 'Identity provider is unavailable or misconfigured.',
  transaction_missing: 'Login transaction expired or was already consumed.',
  provider_refused: 'Identity provider refused login.',
  state_mismatch: 'Login response did not match this browser session.',
  token_rejected: 'Identity response could not be verified.',
};

export default async function AuthErrorPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  return (
    <main style={{ maxWidth: '40rem', margin: '4rem auto', padding: '0 1.5rem' }}>
      <p style={{ color: '#b91c1c', fontWeight: 700 }}>SIGN-IN REFUSED</p>
      <h1>Identity could not be established</h1>
      <p role="alert" aria-live="assertive" className="kf-status kf-status-error">
        {MESSAGES[code ?? ''] ?? 'Login failed closed.'}
      </p>
      <a href="/auth/login?next=/documents">Start a new login</a>
    </main>
  );
}
