'use client';

import { useId, type CSSProperties, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

export function PendingButton({
  children,
  pendingLabel,
  disabled = false,
  className,
  style,
}: {
  readonly children: ReactNode;
  readonly pendingLabel: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  const { pending } = useFormStatus();
  const statusId = useId();

  return (
    <>
      <button
        type="submit"
        disabled={disabled || pending}
        className={['kf-button', className].filter(Boolean).join(' ')}
        aria-describedby={pending ? statusId : undefined}
        aria-busy={pending || undefined}
        style={style}
      >
        {pending ? pendingLabel : children}
      </button>
      <span id={statusId} className="kf-sr-only" role="status" aria-live="polite">
        {pending ? pendingLabel : ''}
      </span>
    </>
  );
}
