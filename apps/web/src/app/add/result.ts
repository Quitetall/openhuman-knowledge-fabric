/**
 * What `/add` says about each file, decided without a server so it can be checked on its own.
 */

export type AddOutcome =
  | {
      readonly status: 'added';
      readonly name: string;
      readonly artifactId: string;
      readonly replayed: boolean;
    }
  | {
      readonly status: 'refused';
      readonly name: string;
      readonly code: string;
      readonly reason: string;
    };

const PLAIN: Readonly<Record<string, string>> = {
  content_refused:
    'It looks like it contains something that is never stored here, such as a password, a private key, or bank or tax details.',
  classification_not_granted:
    'You can’t mark a file as visible to fewer people than you can see yourself. Choose a wider group.',
  document_refused: 'The file couldn’t be read as a document.',
  invalid_ingest: 'The file couldn’t be read.',
  artifact_store_unconfigured: 'Storing files isn’t set up on this server yet.',
  artifact_store_rejected: 'The file store didn’t accept it. Try again in a minute.',
  artifact_conflict: 'A different file with the same fingerprint is already stored.',
  idempotency_conflict: 'This file was already sent with different details. Reload and try again.',
  empty_file: 'The file is empty.',
  file_too_large: 'The file is larger than 10 MB.',
  unavailable: 'The server couldn’t be reached. Try again in a minute.',
  unidentified: 'Your sign-in has expired. Sign in again and retry.',
};

/** A refusal in words a person recognises, keeping the API's own message where it adds detail. */
export function plainReason(code: string, message: string): string {
  const plain = PLAIN[code];
  if (plain === undefined) return message === '' ? 'It couldn’t be added.' : message;
  if (code === 'content_refused' || code === 'invalid_ingest' || code === 'document_refused') {
    return message === '' ? plain : `${plain} (${message})`;
  }
  return plain;
}
