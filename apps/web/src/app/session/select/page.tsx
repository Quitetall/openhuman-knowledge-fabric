import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { CLASSIFICATIONS, sanitizeReturnTo } from '../../../lib/auth';
import { currentWebSession, dogfoodConfig } from '../../../lib/session';
import { PendingButton } from '../../components/pending-button';

export const metadata: Metadata = { title: 'Choose authority context' };

const MESSAGE: Readonly<Record<string, string>> = {
  invalid: 'Context is malformed. Role and organization must be UUIDv7 values.',
  denied: 'API refused this role, organization, or classification context.',
  unavailable: 'API could not validate context. Nothing was saved.',
};

export default async function SelectSessionPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ next?: string; error?: string }>;
}) {
  try {
    dogfoodConfig();
  } catch {
    redirect('/documents');
  }
  const session = await currentWebSession();
  const query = await searchParams;
  const next = sanitizeReturnTo(query.next);
  if (session === undefined) redirect(`/auth/login?next=${encodeURIComponent(next)}`);

  return (
    <main style={{ maxWidth: '38rem', margin: '3rem auto', padding: '0 1.5rem 4rem' }}>
      <p style={{ color: '#475569', margin: 0, letterSpacing: '0.04em', fontSize: '0.8rem' }}>
        AUTHENTICATED SUBJECT
      </p>
      <h1 style={{ marginTop: '0.25rem' }}>Choose authority context</h1>
      <p>
        Identity provider established <code>{session.subject}</code>. KF still requires explicit
        role, organization, and visibility ceiling. API validates all three before saving them.
      </p>
      {query.error === undefined ? null : (
        <p role="alert" aria-live="assertive" className="kf-status kf-status-error">
          <strong>Not selected.</strong> {MESSAGE[query.error] ?? 'Context was refused.'}
        </p>
      )}
      <form method="post" action="/auth/context" style={{ display: 'grid', gap: '1rem' }}>
        <input type="hidden" name="next" value={next} />
        <label>
          <span>Acting role assignment UUIDv7</span>
          <input
            name="actingRoleId"
            required
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
            defaultValue={session.context?.actingRoleId}
            className="kf-control"
          />
        </label>
        <label>
          <span>Organization UUIDv7</span>
          <input
            name="organizationId"
            required
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
            defaultValue={session.context?.organizationId}
            className="kf-control"
          />
        </label>
        <label>
          <span>Maximum classification</span>
          <select
            name="maxClassification"
            defaultValue={session.context?.maxClassification ?? 'internal'}
            className="kf-control"
          >
            {CLASSIFICATIONS.map((classification) => (
              <option key={classification} value={classification}>
                {classification}
              </option>
            ))}
          </select>
        </label>
        <PendingButton
          pendingLabel="Validating authority context…"
          className="kf-button-primary"
          style={{ justifySelf: 'start', padding: '0.55rem 1rem', cursor: 'pointer' }}
        >
          Validate with KF API
        </PendingButton>
      </form>
      <p style={{ marginTop: '1.5rem', color: '#64748b', fontSize: '0.85rem' }}>
        OIDC role claims are ignored. Authority remains in KF role assignments.
      </p>
    </main>
  );
}
