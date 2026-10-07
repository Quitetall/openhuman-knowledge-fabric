import type { Metadata } from 'next';
import { StatusReport } from '../components/status-report';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Status' };

/** `/status` — which capabilities are implemented and what readiness the API measures. */
export default async function StatusPage() {
  return (
    <main className="kf-page kf-page-narrow">
      <StatusReport />
    </main>
  );
}
