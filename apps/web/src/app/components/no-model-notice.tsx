import Link from 'next/link';
import { AI_ANSWERS_PATH } from '../../lib/agent/answers-setting';

/**
 * What a person sees where an answer would be, when no model is set up to write one: a plain
 * sentence and the way to turn answers on, instead of a blank (`data-ask="no-model"`).
 */
export function NoModelNotice({ withResults = true }: { readonly withResults?: boolean }) {
  return (
    <p role="status" className="kf-status kf-status-neutral" data-ask="no-model">
      Written answers are off here, so no model wrote one
      {withResults ? '; here are the records that match your words' : ''}.{' '}
      <Link href={AI_ANSWERS_PATH} data-ai-answers-link="">
        Turn on AI answers
      </Link>
    </p>
  );
}
