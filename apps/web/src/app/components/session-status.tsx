import { loadWebIdentityConfig } from '../../lib/auth';
import { identityLine } from '../../lib/auth/identity-label';
import { developmentCaller } from '../../lib/caller';
import { currentIdentityLabel, currentWebSession } from '../../lib/session';
import { ContextLink } from './context-link';
import { IdentityBar } from './identity-bar';
import { PendingButton } from './pending-button';

function SignOut() {
  return (
    <form method="post" action="/auth/logout" className="kf-signout">
      <PendingButton pendingLabel="Signing out…" className="kf-button-quiet">
        Sign out
      </PendingButton>
    </form>
  );
}

export async function SessionStatus() {
  const config = loadWebIdentityConfig();
  if (config.profile === 'development') {
    const caller = developmentCaller();
    return (
      <div className="kf-session-status">
        <IdentityBar
          line={{
            person: 'Development identity',
            role: 'Fixed role',
            organization: 'Fixed organization',
            ceiling: caller.maxClassification,
          }}
          ceiling={caller.maxClassification}
          ids={[
            { label: 'Subject', value: caller.actorId },
            { label: 'Organization id', value: caller.organizationId },
            { label: 'Role assignment id', value: caller.actingRoleId },
          ]}
        />
      </div>
    );
  }
  const session = await currentWebSession();
  if (session === undefined) {
    return (
      <div className="kf-session-status">
        <a href="/auth/login?next=/" className="kf-button kf-button-primary kf-button-small">
          Sign in
        </a>
      </div>
    );
  }
  if (session.context === undefined) {
    return (
      <div className="kf-session-status" aria-label="Current authority context">
        <span className="kf-muted">Choose how you are working today to continue.</span>
        <SignOut />
      </div>
    );
  }
  const label = await currentIdentityLabel(session);
  return (
    <div className="kf-session-status">
      <IdentityBar
        line={identityLine(label, session.context)}
        ceiling={session.context.maxClassification}
        ids={[
          { label: 'Sign-in subject', value: session.subject },
          { label: 'Organization id', value: session.context.organizationId },
          { label: 'Role assignment id', value: session.context.actingRoleId },
        ]}
        actions={<ContextLink />}
      />
      <SignOut />
    </div>
  );
}
