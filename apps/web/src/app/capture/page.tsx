import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import { PHOTO_MEDIA_TYPES, VOICE_MEDIA_TYPES, classificationsUpTo } from '../../lib/api/capture';
import { webCaller } from '../../lib/session';
import { CaptureForm } from './capture-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Quick note' };

/**
 * `/capture` — note something down (ADR 0024, ADR 0034). The page resolves the caller first, so a
 * signed-out visitor is sent to sign in before writing a note they could not record.
 */
export default async function CapturePage() {
  const caller = await webCaller('/capture');
  return (
    <main className="kf-page kf-page-narrow">
      <h1 className="kf-title">Quick note</h1>
      <p className="kf-lede">
        Write down what you saw or did, with a photo or voice note if it helps. It is saved as you,
        and someone else checks it later.
      </p>
      <CaptureForm
        gestureId={randomUUID()}
        classifications={classificationsUpTo(caller.maxClassification)}
        photoAccept={PHOTO_MEDIA_TYPES.join(',')}
        voiceAccept={VOICE_MEDIA_TYPES.join(',')}
      />
    </main>
  );
}
