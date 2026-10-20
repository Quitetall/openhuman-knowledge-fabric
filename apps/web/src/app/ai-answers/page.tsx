import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { loadAgentConfig } from '../../lib/agent/config';
import {
  answersSetting,
  ceilingWords,
  routingAdvice,
  settingWords,
  type AnswersSetting,
} from '../../lib/agent/answers-setting';
import { getModelRouting, type ModelRouting } from '../../lib/api/model-routing';
import { webCaller } from '../../lib/session';
import { alignRouting } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'AI answers' };

/**
 * `/ai-answers`: who writes the answers to "Ask" here, and what the organization lets leave this
 * computer, in plain words, with the one button that brings the second in line with the first.
 *
 * Who writes answers is the deployment's: this page reads it and does not change it. On a
 * Knowledge Fabric started from its desktop icon, the icon's "AI answers" action changes it
 * (scripts/workspace); on a server, whoever runs the server does. What may leave is the
 * organization's, changed only by the signed-in person's own `set_model_routing_policy` act.
 */
export default async function AiAnswersPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await webCaller('/ai-answers');
  const params = await searchParams;
  let setting: AnswersSetting | undefined;
  try {
    setting = answersSetting(loadAgentConfig());
  } catch {
    setting = undefined;
  }
  let routing: ModelRouting | undefined;
  try {
    routing = await getModelRouting(caller);
  } catch {
    routing = undefined;
  }
  const advice =
    setting === undefined || routing === undefined
      ? undefined
      : routingAdvice(setting, routing.providerCeiling);
  const done = typeof params['done'] === 'string' ? params['done'] : undefined;
  const refused = typeof params['refused'] === 'string' ? params['refused'] : undefined;
  return (
    <main className="kf-page kf-page-narrow">
      <h1 className="kf-title">AI answers</h1>
      <p className="kf-lede">
        When you ask a question, a model can write the answer from the records you may see, and list
        its sources. Here is who writes it, and what may leave this computer.
      </p>
      {done === undefined ? null : (
        <p role="status" className="kf-notice kf-outcome">
          {done}
        </p>
      )}
      {refused === undefined ? null : (
        <p role="alert" className="kf-notice kf-outcome">
          Not changed: {refused}
        </p>
      )}
      <section aria-labelledby="who" data-answers-setting={setting?.choice ?? 'unreadable'}>
        <h2 id="who">Who writes answers</h2>
        <p>
          {setting === undefined
            ? 'The AI answers settings of this Knowledge Fabric could not be read; answers are off until they are fixed.'
            : settingWords(setting)}
        </p>
        <p className="kf-footnote">
          To change it on a Knowledge Fabric you started from its icon: right-click the Knowledge
          Fabric icon on that computer and choose “AI answers”. Otherwise, ask the person who runs
          this Knowledge Fabric.
        </p>
      </section>
      <section
        aria-labelledby="leave"
        data-provider-ceiling={routing?.providerCeiling ?? 'unknown'}
      >
        <h2 id="leave">What may leave this computer</h2>
        <p>
          {routing === undefined
            ? 'Your organization’s rule could not be read just now. Until it can, nothing is sent to a cloud model.'
            : ceilingWords(routing.providerCeiling)}
        </p>
        <p className="kf-footnote">
          This is your organization’s decision, recorded as somebody’s act, and it applies to every
          cloud model the same way.
        </p>
        {advice === undefined ? null : (
          <form action={alignRouting} data-routing-advice={advice.ceiling}>
            <p>{advice.why}</p>
            <input type="hidden" name="ceiling" value={advice.ceiling} />
            <input type="hidden" name="gestureId" value={randomUUID()} />
            <button type="submit" className="kf-button kf-button-primary">
              {advice.button}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
