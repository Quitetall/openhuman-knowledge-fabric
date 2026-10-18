'use client';

import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { CLASSIFICATION_WORDS } from '../../lib/auth/identity-label';
import { addOneFile } from './actions';
import { AddResults } from './add-results';
import type { AddOutcome } from './result';

/**
 * Choose or drop any number of files, say who can see them, and add them. Each file is sent on
 * its own (`addOneFile`), one after another, and its result is listed as soon as it is known.
 */
export function AddFiles({
  choices,
  initial,
}: {
  readonly choices: readonly string[];
  readonly initial: string;
}) {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [outcomes, setOutcomes] = useState<readonly AddOutcome[]>([]);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = (list: FileList | null) => {
    if (list === null) return;
    setFiles((current) => [...current, ...Array.from(list)]);
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files);
  };
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (files.length === 0 || busy !== undefined) return;
    const form = new FormData(event.currentTarget);
    const results: AddOutcome[] = [];
    setOutcomes([]);
    for (const [index, file] of files.entries()) {
      setBusy(`Adding ${index + 1} of ${files.length}: ${file.name}`);
      const one = new FormData();
      one.set('file', file);
      one.set('classification', String(form.get('classification') ?? ''));
      one.set('note', String(form.get('note') ?? ''));
      try {
        results.push(await addOneFile(one));
      } catch {
        results.push({
          status: 'refused',
          name: file.name,
          code: 'unavailable',
          reason: 'The server couldn’t be reached. Try again in a minute.',
        });
      }
      setOutcomes([...results]);
    }
    setBusy(undefined);
    setFiles([]);
    if (input.current !== null) input.current.value = '';
  };

  return (
    <div className="kf-add">
      <form onSubmit={onSubmit} className="kf-add-form">
        <label
          className={`kf-dropzone${over ? ' kf-dropzone-over' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <span className="kf-dropzone-title">Drop files here</span>
          <span className="kf-muted">or</span>
          <span className="kf-button">Choose files</span>
          <input
            ref={input}
            type="file"
            name="files"
            multiple
            className="kf-sr-only"
            aria-label="Choose files"
            onChange={(event) => take(event.currentTarget.files)}
          />
        </label>
        {files.length === 0 ? (
          <p className="kf-muted">No files chosen yet. Up to 10 MB each.</p>
        ) : (
          <ul className="kf-add-chosen" aria-label="Files to add">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`}>
                {file.name}{' '}
                <span className="kf-muted">({Math.max(1, Math.round(file.size / 1024))} KB)</span>{' '}
                <button
                  type="button"
                  className="kf-link-button"
                  onClick={() => setFiles((current) => current.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <label>
          <span>Who can see these files</span>
          <select name="classification" defaultValue={initial} className="kf-control">
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {CLASSIFICATION_WORDS[choice] ?? choice}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Note (optional)</span>
          <textarea
            name="note"
            rows={2}
            maxLength={2000}
            className="kf-control"
            placeholder="Why these files matter, or where they came from"
          />
        </label>
        <button
          type="submit"
          className="kf-button kf-button-primary kf-button-large"
          disabled={files.length === 0 || busy !== undefined}
          aria-busy={busy !== undefined}
        >
          {busy === undefined
            ? files.length <= 1
              ? 'Add file'
              : `Add ${files.length} files`
            : 'Adding…'}
        </button>
        <p role="status" aria-live="polite" className="kf-muted">
          {busy ?? ''}
        </p>
      </form>
      <AddResults outcomes={outcomes} />
    </div>
  );
}
