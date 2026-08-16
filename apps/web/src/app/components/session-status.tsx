import { loadWebIdentityConfig } from '../../lib/auth';
import { developmentCaller } from '../../lib/caller';
import { currentWebSession } from '../../lib/session';
import { ContextLink } from './context-link';
import { PendingButton } from './pending-button';

export async function SessionStatus() {
  const config = loadWebIdentityConfig();
  if (config.profile === 'development') {
    const caller = developmentCaller();
    return (
      <div
        className="kf-session-status"
        aria-label="Current authority context"
        style={{ marginLeft: 'auto', color: '#92400e', fontSize: '0.78rem' }}
      >
        <strong>FIXED DEVELOPMENT IDENTITY</strong>
        <span className="kf-session-facts">
          <span>
            Subject <code>{caller.actorId}</code>
          </span>
          <span>
            Organization <code>{caller.organizationId}</code>
          </span>
          <span>
            Role <code>{caller.actingRoleId}</code>
          </span>
          <span>
            Classification <strong>{caller.maxClassification}</strong>
          </span>
        </span>
      </div>
    );
  }
  const session = await currentWebSession();
  if (session === undefined) {
    return (
      <a
        href="/auth/login?next=/documents"
        style={{ marginLeft: 'auto', color: '#1d4ed8', textDecoration: 'none' }}
      >
        Sign in
      </a>
    );
  }
  return (
    <div
      className="kf-session-status"
      aria-label="Current authority context"
      style={{
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: '0.65rem',
        fontSize: '0.78rem',
      }}
    >
      <span className="kf-session-facts">
        <span>
          OIDC subject <code>{session.subject}</code>
        </span>
        {session.context === undefined ? (
          <strong>Authority context required</strong>
        ) : (
          <>
            <span>
              Organization <code>{session.context.organizationId}</code>
            </span>
            <span>
              Role <code>{session.context.actingRoleId}</code>
            </span>
            <span>
              Classification <strong>{session.context.maxClassification}</strong>
            </span>
          </>
        )}
      </span>
      <ContextLink />
      <form method="post" action="/auth/logout" style={{ margin: 0 }}>
        <PendingButton pendingLabel="Signing out…">Sign out</PendingButton>
      </form>
    </div>
  );
}
