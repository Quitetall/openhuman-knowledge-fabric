import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  getSessionContexts,
  type SessionContextOrganization,
  type SessionContexts,
} from '../../../lib/api';
import { CLASSIFICATIONS, sanitizeReturnTo, type WebSession } from '../../../lib/auth';
import { currentWebSession, dogfoodConfig } from '../../../lib/session';
import { PendingButton } from '../../components/pending-button';
import {
  ceilingOptions,
  contextsFailure,
  defaultCeiling,
  orderOrganizations,
  organizationName,
  organizationRefusal,
  preselectedAssignment,
  roleName,
  validUntil,
} from './context-picker';

export const metadata: Metadata = { title: 'Choose authority context' };

const MESSAGE: Readonly<Record<string, string>> = {
  invalid:
    'Context is malformed. The role assignment must be a UUID and the organization a UUIDv7.',
  denied: 'API refused this role, organization, or classification context.',
  unavailable: 'API could not validate context. Nothing was saved.',
};

/** Accepts every RFC 4122 version: some live role assignments predate time-ordered ids. */
const UUID_PATTERN =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const UUID_V7_PATTERN =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';

type Menu =
  | { readonly kind: 'listed'; readonly contexts: SessionContexts }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Ask the API what this person may choose from: every live assignment they hold, in every
 * organization they hold one in. The bearer token alone says whose; no organization is named, so
 * the deployment's configured one is only an order of display, never a limit on what is listed.
 */
async function loadMenu(session: WebSession): Promise<Menu> {
  try {
    return { kind: 'listed', contexts: await getSessionContexts(session.accessToken) };
  } catch (error: unknown) {
    return { kind: 'failed', reason: contextsFailure(error) };
  }
}

function ManualForm({
  session,
  next,
  organizationId,
}: {
  readonly session: WebSession;
  readonly next: string;
  readonly organizationId: string | undefined;
}) {
  return (
    <form method="post" action="/auth/context" style={{ display: 'grid', gap: '1rem' }}>
      <input type="hidden" name="next" value={next} />
      <label>
        <span>Acting role assignment id (UUID)</span>
        <input
          name="actingRoleId"
          required
          pattern={UUID_PATTERN}
          defaultValue={session.context?.actingRoleId}
          className="kf-control"
        />
      </label>
      <label>
        <span>Organization id (UUIDv7)</span>
        <input
          name="organizationId"
          required
          pattern={UUID_V7_PATTERN}
          defaultValue={organizationId}
          className="kf-control"
        />
      </label>
      <label>
        <span id="manual-ceiling-label">Maximum classification (typed ids)</span>
        <select
          aria-labelledby="manual-ceiling-label"
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
        Validate typed ids with KF API
      </PendingButton>
    </form>
  );
}

function OrganizationPicker({
  session,
  next,
  organization,
}: {
  readonly session: WebSession;
  readonly next: string;
  readonly organization: SessionContextOrganization;
}) {
  const name = organizationName(organization);
  const headingId = `organization-${organization.organizationId}`;
  const ceilingId = `picker-ceiling-${organization.organizationId}`;
  if (organization.refused !== null || organization.clearance === null) {
    return (
      <section
        aria-labelledby={headingId}
        data-organization={organization.organizationId}
        data-organization-refused={organization.refused ?? 'unknown'}
        style={{ border: '1px solid #cbd5e1', borderRadius: '0.5rem', padding: '0.75rem 1rem' }}
      >
        <h2 id={headingId} style={{ margin: 0, fontSize: '1.05rem' }}>
          {name}
        </h2>
        <p role="status" className="kf-status kf-status-warning" style={{ marginBottom: 0 }}>
          {organizationRefusal(organization.refused ?? 'unknown')}
        </p>
      </section>
    );
  }
  const selected = preselectedAssignment(organization.assignments, session.context);
  const ceilings = ceilingOptions(organization.clearance);
  return (
    <section
      aria-labelledby={headingId}
      data-organization={organization.organizationId}
      style={{ border: '1px solid #cbd5e1', borderRadius: '0.5rem', padding: '0.75rem 1rem' }}
    >
      <h2 id={headingId} style={{ margin: 0, fontSize: '1.05rem' }}>
        {name}
      </h2>
      <p style={{ margin: '0.25rem 0 0.75rem' }}>
        <code style={{ color: '#64748b', fontSize: '0.75rem' }}>{organization.organizationId}</code>
      </p>
      <form method="post" action="/auth/context" style={{ display: 'grid', gap: '1rem' }}>
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="organizationId" value={organization.organizationId} />
        <fieldset
          style={{ border: '1px solid #cbd5e1', borderRadius: '0.5rem', padding: '0.75rem 1rem' }}
        >
          <legend>Acting role</legend>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {organization.assignments.map((assignment) => (
              <label
                key={assignment.assignmentId}
                style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}
              >
                <input
                  type="radio"
                  name="actingRoleId"
                  value={assignment.assignmentId}
                  required
                  defaultChecked={assignment.assignmentId === selected}
                />
                <span>
                  <strong>{roleName(assignment.roleId)}</strong>{' '}
                  <span style={{ color: '#475569', fontSize: '0.85rem' }}>
                    · {validUntil(assignment.validTo)}
                  </span>
                  <br />
                  <code style={{ color: '#64748b', fontSize: '0.75rem' }}>
                    {assignment.assignmentId}
                  </code>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          <span id={ceilingId}>Maximum classification</span>
          <select
            aria-labelledby={ceilingId}
            name="maxClassification"
            defaultValue={defaultCeiling(
              organization.clearance,
              session.context,
              organization.organizationId,
            )}
            className="kf-control"
          >
            {ceilings.map((classification) => (
              <option key={classification} value={classification}>
                {classification}
              </option>
            ))}
          </select>
        </label>
        <p style={{ margin: 0, color: '#475569', fontSize: '0.85rem' }}>
          Your clearance here is <strong>{organization.clearance}</strong>; a lower ceiling hides
          more.
        </p>
        <PendingButton
          pendingLabel="Validating authority context…"
          className="kf-button-primary"
          style={{ justifySelf: 'start', padding: '0.55rem 1rem', cursor: 'pointer' }}
        >
          Validate with KF API
        </PendingButton>
      </form>
    </section>
  );
}

export default async function SelectSessionPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ next?: string; error?: string }>;
}) {
  let config;
  try {
    config = dogfoodConfig();
  } catch {
    redirect('/documents');
  }
  const session = await currentWebSession();
  const query = await searchParams;
  const next = sanitizeReturnTo(query.next);
  if (session === undefined) redirect(`/auth/login?next=${encodeURIComponent(next)}`);
  const menu = await loadMenu(session);
  const organizations =
    menu.kind === 'listed'
      ? orderOrganizations(menu.contexts.organizations, session.context, config.organizationId)
      : [];
  const pickable = organizations.some((organization) => organization.refused === null);

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
      {menu.kind === 'failed' ? (
        <p role="status" className="kf-status kf-status-warning" data-assignments="unavailable">
          <strong>Your assignments could not be listed.</strong> {menu.reason} You can still enter
          the ids by hand.
        </p>
      ) : null}
      {menu.kind === 'listed' && !pickable ? (
        <p role="status" className="kf-status kf-status-warning" data-assignments="empty">
          The API lists no role assignment you can choose in any organization.
        </p>
      ) : null}
      {organizations.length > 0 ? (
        <div data-organization-list="" style={{ display: 'grid', gap: '1rem' }}>
          {organizations.map((organization) => (
            <OrganizationPicker
              key={organization.organizationId}
              session={session}
              next={next}
              organization={organization}
            />
          ))}
        </div>
      ) : null}
      <details open={!pickable} style={{ marginTop: pickable ? '1.5rem' : '1rem' }}>
        <summary style={{ cursor: 'pointer' }}>Enter ids manually</summary>
        <div style={{ marginTop: '1rem' }}>
          <ManualForm
            session={session}
            next={next}
            organizationId={
              // The first organization offered (the one in use, else the preferred one when the
              // person holds something there, else the first listed); the configured one only
              // when nothing is listed, so the form never shows a person another tenant's id.
              organizations[0]?.organizationId ??
              session.context?.organizationId ??
              config.organizationId
            }
          />
        </div>
      </details>
      <p style={{ marginTop: '1.5rem', color: '#64748b', fontSize: '0.85rem' }}>
        OIDC role claims are ignored. Authority remains in KF role assignments.
      </p>
    </main>
  );
}
