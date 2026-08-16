'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

/** Build the convenience return target in-browser; both receiving server routes sanitize it. */
export function ContextLink() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const returnTo = query === '' ? pathname : `${pathname}?${query}`;
  const target = new URLSearchParams({ next: returnTo });

  return <Link href={`/session/select?${target}`}>Change context</Link>;
}
