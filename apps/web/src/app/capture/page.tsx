import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import { PHOTO_MEDIA_TYPES, VOICE_MEDIA_TYPES, classificationsUpTo } from '../../lib/api/capture';
import { webCaller } from '../../lib/session';
import { CaptureForm } from './capture-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Capture' };

/**
 * `/capture` — note something down (ADR 0024, ADR 0034). The page resolves the caller first, so a
 * signed-out visitor is sent to sign in before writing a note they could not record.
 */
export default async function CapturePage() {
  const caller = await webCaller('/capture');
  return (
    <main style={{ maxWidth: '72rem', margin: '0 auto', padding: '2.5rem 1.5rem 5rem' }}>
      <div style={{ maxWidth: '52rem' }}>
        <p style={{ color: '#64748b', margin: 0, fontSize: '0.85rem', letterSpacing: '0.04em' }}>
          ONE GESTURE, ONE OBSERVATION
        </p>
        <h1 style={{ margin: '0.25rem 0 0.5rem', fontSize: '2rem' }}>Capture an observation</h1>
        <p style={{ color: '#475569', marginTop: 0 }}>
          Recorded as you, under your selected role, the moment you submit. It stays unverified
          until somebody else checks it, and becomes a controlled record only when somebody with
          authority promotes it. A photo or voice note you attach is stored as evidence on it.
        </p>
      </div>
      <CaptureForm
        gestureId={randomUUID()}
        classifications={classificationsUpTo(caller.maxClassification)}
        photoAccept={PHOTO_MEDIA_TYPES.join(',')}
        voiceAccept={VOICE_MEDIA_TYPES.join(',')}
      />
    </main>
  );
}
