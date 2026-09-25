import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getSessionAssignments, type SessionAssignments } from '../../../lib/api';
import { CLASSIFICATIONS, sanitizeReturnTo, type WebSession } from '../../../lib/auth';
import { currentWebSession, dogfoodConfig } from '../../../lib/session';
import { PendingButton } from '../../components/pending-button';
import {
  assignmentsFailure,
  ceilingOptions,
  defaultCeiling,
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
  | { readonly kind: 'unknown_organization' }
  | { readonly kind: 'listed'; readonly assignments: SessionAssignments }
  | { readonly kind: 'failed'; readonly organizationId: string; readonly reason: string };

/**
 * Ask the API what this person may choose from. The organization comes from the context already
 * in use, else the deployment's configured one; with neither there is nothing to ask about, and
 * the person types the ids as before.
 */
async function loadMenu(session: WebSession, configured: string | undefined): Promise<Menu> {
  const organizationId = session.context?.organizationId ?? configured;
  if (organizationId === undefined) return { kind: 'unknown_organization' };
  try {
    return {
      kind: 'listed',
      assignments: await getSessionAssignments(session.accessToken, organizationId),
    };
  } catch (error: unknown) {
    return { kind: 'failed', organizationId, reason: assignmentsFailure(error) };
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

function AssignmentPicker({
  session,
  next,
  menu,
}: {
  readonly session: WebSession;
  readonly next: string;
  readonly menu: SessionAssignments;
}) {
  const selected = preselectedAssignment(menu.assignments, session.context);
  const ceilings = ceilingOptions(menu.clearance);
  return (
    <form method="post" action="/auth/context" style={{ display: 'grid', gap: '1rem' }}>
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="organizationId" value={menu.organizationId} />
      <p style={{ margin: 0 }}>
        Organization <code data-organization={menu.organizationId}>{menu.organizationId}</code>
      </p>
      <fieldset
        style={{ border: '1px solid #cbd5e1', borderRadius: '0.5rem', padding: '0.75rem 1rem' }}
      >
        <legend>Acting role</legend>
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {menu.assignments.map((assignment) => (
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
        <span id="picker-ceiling-label">Maximum classification</span>
        <select
          aria-labelledby="picker-ceiling-label"
          name="maxClassification"
          defaultValue={defaultCeiling(menu.clearance, session.context, menu.organizationId)}
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
        Your clearance here is <strong>{menu.clearance}</strong>; a lower ceiling hides more.
      </p>
      <PendingButton
        pendingLabel="Validating authority context…"
        className="kf-button-primary"
        style={{ justifySelf: 'start', padding: '0.55rem 1rem', cursor: 'pointer' }}
      >
        Validate with KF API
      </PendingButton>
    </form>
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
  const menu = await loadMenu(session, config.organizationId);
  const pickable = menu.kind === 'listed' && menu.assignments.assignments.length > 0;

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
          The API lists no live role assignment for you in this organization.
        </p>
      ) : null}
      {pickable ? <AssignmentPicker session={session} next={next} menu={menu.assignments} /> : null}
      <details open={!pickable} style={{ marginTop: pickable ? '1.5rem' : '1rem' }}>
        <summary style={{ cursor: 'pointer' }}>Enter ids manually</summary>
        <div style={{ marginTop: '1rem' }}>
          <ManualForm
            session={session}
            next={next}
            organizationId={
              menu.kind === 'listed'
                ? menu.assignments.organizationId
                : menu.kind === 'failed'
                  ? menu.organizationId
                  : undefined
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
