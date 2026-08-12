import { formatState, stateTone } from '@kf/ui';

const TONE: Record<string, string> = {
  draft: '#6b7280',
  active: '#047857',
  awaiting: '#b45309',
  terminal: '#4338ca',
};

export function Badge({ state }: { readonly state: string }) {
  const colour = TONE[stateTone(state)] ?? '#475569';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.1rem 0.5rem',
        borderRadius: '999px',
        fontSize: '0.8rem',
        border: `1px solid ${colour}`,
        color: colour,
        whiteSpace: 'nowrap',
      }}
    >
      {formatState(state)}
    </span>
  );
}
