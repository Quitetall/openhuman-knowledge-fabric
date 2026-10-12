'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Record a voice note in the browser and put it on the capture form as a file (ADR 0040 decision
 * 10; KF-SAS-RQ-273).
 *
 * The recording is made with the browser's MediaRecorder from the microphone the person allows,
 * kept in this page, played back for them to check, and submitted with the form as the `voice`
 * file, exactly as if they had chosen a file. Nothing listens to it: no speech recognition (the
 * browser's own sends audio to its vendor), no transcription, no upload anywhere but the form's
 * own submission to this application. Where the browser cannot record, or the person refuses the
 * microphone, the form takes a recording made by the phone's own recorder instead.
 */

const MAX_SECONDS = 10 * 60;
/** In the order a browser is asked; Chrome and Firefox record webm/opus, Safari mp4/aac. */
const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];

type Phase =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'recording'; readonly seconds: number }
  | { readonly kind: 'recorded'; readonly url: string; readonly seconds: number }
  | { readonly kind: 'fallback'; readonly why: string };

function clock(seconds: number): string {
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

export function VoiceNote({ accept }: { readonly accept: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const input = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const capable =
      typeof window.MediaRecorder === 'function' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      typeof window.DataTransfer === 'function';
    setPhase(
      capable ? { kind: 'ready' } : { kind: 'fallback', why: 'This browser cannot record here.' },
    );
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(
    () => () => {
      if (phase.kind === 'recorded') URL.revokeObjectURL(phase.url);
    },
    [phase],
  );

  const start = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase({
        kind: 'fallback',
        why: 'The microphone was not allowed, so record with your phone and attach the file.',
      });
      return;
    }
    const mimeType = RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const media = new MediaRecorder(stream, mimeType === undefined ? {} : { mimeType });
    const chunks: Blob[] = [];
    let seconds = 0;
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    media.onstop = () => {
      if (timer.current !== null) clearInterval(timer.current);
      stream.getTracks().forEach((track) => track.stop());
      const type = (media.mimeType || mimeType || 'audio/webm').split(';')[0]!;
      const extension = type === 'audio/mp4' ? 'm4a' : type.slice('audio/'.length);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = new File(chunks, `voice-note-${stamp}.${extension}`, { type });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      if (input.current !== null) input.current.files = transfer.files;
      setPhase({ kind: 'recorded', url: URL.createObjectURL(file), seconds });
    };
    recorder.current = media;
    media.start();
    setPhase({ kind: 'recording', seconds: 0 });
    timer.current = setInterval(() => {
      seconds += 1;
      if (seconds >= MAX_SECONDS) media.stop();
      else setPhase({ kind: 'recording', seconds });
    }, 1000);
  };

  const stop = () => recorder.current?.stop();

  const discard = () => {
    if (input.current !== null) input.current.value = '';
    setPhase({ kind: 'ready' });
  };

  if (phase.kind === 'fallback') {
    return (
      <div className="kf-capture-media" data-voice="fallback">
        <label>
          <span>Voice note (optional)</span>
          <input type="file" name="voice" accept={accept} capture="user" className="kf-control" />
        </label>
        <p className="kf-footnote">{phase.why}</p>
      </div>
    );
  }
  return (
    <div className="kf-capture-media" data-voice={phase.kind}>
      <span id="kf-voice-label">Voice note (optional)</span>
      {/* The recording travels as this input's file; it is filled by the recorder, not typed. */}
      <input
        ref={input}
        type="file"
        name="voice"
        accept={accept}
        hidden
        tabIndex={-1}
        aria-hidden="true"
      />
      <div className="kf-action-controls" aria-labelledby="kf-voice-label" role="group">
        {phase.kind === 'recording' ? (
          <button type="button" className="kf-button kf-button-primary" onClick={stop}>
            Stop recording
          </button>
        ) : phase.kind === 'recorded' ? (
          <>
            <audio controls src={phase.url} aria-label="Your voice note" />
            <button type="button" className="kf-button" onClick={discard}>
              Discard voice note
            </button>
          </>
        ) : (
          <button
            type="button"
            className="kf-button"
            onClick={() => void start()}
            disabled={phase.kind === 'checking'}
          >
            Record a voice note
          </button>
        )}
      </div>
      <p className="kf-footnote" role="status" aria-live="polite">
        {phase.kind === 'recording'
          ? `Recording ${clock(phase.seconds)} of at most ${clock(MAX_SECONDS)}.`
          : phase.kind === 'recorded'
            ? `Voice note of ${clock(phase.seconds)} ready; it is stored as evidence and not transcribed.`
            : 'Recorded here and stored as evidence. It is not transcribed or sent anywhere else.'}
      </p>
    </div>
  );
}
