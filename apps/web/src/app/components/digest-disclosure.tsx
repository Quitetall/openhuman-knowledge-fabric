import { shortDigest } from '@kf/ui';

export function DigestDisclosure({
  digest,
  label = 'digest',
}: {
  readonly digest: string;
  readonly label?: string;
}) {
  return (
    <details style={{ display: 'inline-block', maxWidth: '100%', overflowWrap: 'anywhere' }}>
      <summary style={{ cursor: 'pointer' }}>
        <code>{shortDigest(digest)}</code>{' '}
        <span style={{ color: '#64748b', fontSize: '0.8rem' }}>Show exact {label}</span>
      </summary>
      <code style={{ display: 'block', marginTop: '0.25rem', overflowWrap: 'anywhere' }}>
        {digest}
      </code>
    </details>
  );
}
