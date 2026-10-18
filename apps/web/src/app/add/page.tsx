import type { Metadata } from 'next';
import { classificationsUpTo } from '../../lib/api/capture';
import { webCaller } from '../../lib/session';
import { AddFiles } from './add-files';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Add files' };

/**
 * `/add` — put any files into the Fabric. Each becomes a record of its own, added as the person,
 * unverified until someone with authority checks it. Who can see it is chosen once for the batch,
 * offered only up to what the person can see themselves (the API refuses anything higher).
 */
export default async function AddPage() {
  const caller = await webCaller('/add');
  const choices = classificationsUpTo(caller.maxClassification);
  return (
    <main className="kf-page kf-page-narrow">
      <h1 className="kf-title">Add files</h1>
      <p className="kf-lede">
        Drop in any files you want kept and findable. Each one is added as you.
      </p>
      <AddFiles
        choices={choices}
        initial={choices.includes('internal') ? 'internal' : (choices.at(-1) ?? 'public')}
      />
    </main>
  );
}
