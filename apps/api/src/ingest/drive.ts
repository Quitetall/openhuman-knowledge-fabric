/**
 * Google Drive as an external Source Holder for ingestion (ADR 0022, deciding ADR 0009's
 * deferred design in its narrowest form).
 *
 * A Drive file becomes an artifact version by the SAME path a local file does — bytes are
 * fetched, hashed, put into the working store with create-only semantics, and attached by
 * `attach_evidence` — with three facts recorded that a local file does not have: the file id
 * and the exact revision the bytes were read at (`google-drive` locator, authority
 * `authoritative`: Drive holds the source, we hold a copy), and the exporter identity for a
 * Google-native document (Docs, Sheets, Slides have no bytes of their own; `files.export` with
 * a named MIME type is the converter, and two exporters can differ the way two pandocs do).
 *
 * Nothing here writes. The client is an interface so a test can supply a fake, and the real
 * one authenticates as a service account through a signed JWT — no user consent flow, no
 * refresh tokens on disk, the key file permission-checked like every other secret.
 */

import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { readSecretFile } from '@kf/operations';

export const DRIVE_API_VERSION = 'v3';
export const DRIVE_EXPORTER = `google-drive-api-${DRIVE_API_VERSION}`;

/** Google-native types that have no bytes of their own and must be exported. */
const NATIVE_TYPES: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'text/markdown',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'application/pdf',
};

export interface DriveFileFacts {
  readonly fileId: string;
  readonly name: string;
  /** The Drive MIME type of the source (a Google-native type for Docs/Sheets/Slides). */
  readonly sourceMimeType: string;
  /** The revision the bytes were read at — `headRevisionId`, or the requested revision. */
  readonly revisionId: string;
  readonly modifiedTime: string;
  readonly webViewLink: string | undefined;
}

export interface DriveFetched extends DriveFileFacts {
  readonly bytes: Buffer;
  /** The MIME type of the bytes we hold: the export target for native types, else the source's. */
  readonly mediaType: string;
  /** How the bytes were produced: `files.get alt=media` or `files.export mimeType=…`. */
  readonly exporter: string;
}

export interface DriveClient {
  fetch(
    fileId: string,
    options: { revisionId?: string; exportMimeType?: string },
  ): Promise<DriveFetched>;
}

/** `<fileId>` or `<fileId>@<revisionId>`. */
export function parseDriveRef(ref: string): { fileId: string; revisionId?: string } {
  const match = /^([A-Za-z0-9_-]{10,})(?:@([A-Za-z0-9_-]+))?$/.exec(ref);
  if (match === null) {
    throw new Error(`not a Drive reference: ${ref} (expected <fileId> or <fileId>@<revisionId>)`);
  }
  return { fileId: match[1]!, ...(match[2] === undefined ? {} : { revisionId: match[2] }) };
}

export function exportTargetFor(sourceMimeType: string, requested?: string): string | undefined {
  if (requested !== undefined) return requested;
  return NATIVE_TYPES[sourceMimeType];
}

export interface DriveServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

/** Read a service-account key file the way every other secret is read: permission-checked. */
export function loadDriveServiceAccount(path: string): DriveServiceAccount {
  const parsed = JSON.parse(
    readSecretFile(path, 'KF_DRIVE_SERVICE_ACCOUNT_FILE'),
  ) as Partial<DriveServiceAccount>;
  if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    throw new Error('the Drive service-account file needs client_email and private_key');
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    ...(typeof parsed.token_uri === 'string' ? { token_uri: parsed.token_uri } : {}),
  };
}

/**
 * The real client: a service-account JWT exchanged for a short-lived access token, then the
 * Drive v3 endpoints. Read-only scope; the token lives in memory for one run.
 */
export class GoogleDriveClient implements DriveClient {
  readonly #account: DriveServiceAccount;
  readonly #fetch: typeof fetch;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(account: DriveServiceAccount, fetchImpl: typeof fetch = fetch) {
    this.#account = account;
    this.#fetch = fetchImpl;
  }

  async #accessToken(): Promise<string> {
    if (this.#token !== undefined && this.#token.expiresAt > Date.now() + 30_000) {
      return this.#token.value;
    }
    const tokenUri = this.#account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const assertion = await new SignJWT({
      scope: 'https://www.googleapis.com/auth/drive.readonly',
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.#account.client_email)
      .setSubject(this.#account.client_email)
      .setAudience(tokenUri)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(createPrivateKey(this.#account.private_key));
    const response = await this.#fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!response.ok) {
      throw new Error(`Drive token exchange failed: HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== 'string')
      throw new Error('Drive token exchange returned no token');
    this.#token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return this.#token.value;
  }

  async #get(url: string): Promise<Response> {
    const token = await this.#accessToken();
    const response = await this.#fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok)
      throw new Error(`Drive ${url.split('?')[0]}: HTTP ${String(response.status)}`);
    return response;
  }

  async fetch(
    fileId: string,
    options: { revisionId?: string; exportMimeType?: string },
  ): Promise<DriveFetched> {
    const base = `https://www.googleapis.com/drive/${DRIVE_API_VERSION}/files/${encodeURIComponent(fileId)}`;
    const meta = (await (
      await this.#get(
        `${base}?fields=id,name,mimeType,headRevisionId,modifiedTime,webViewLink&supportsAllDrives=true`,
      )
    ).json()) as {
      id: string;
      name: string;
      mimeType: string;
      headRevisionId?: string;
      modifiedTime: string;
      webViewLink?: string;
    };
    const exportTarget = exportTargetFor(meta.mimeType, options.exportMimeType);
    const revisionId = options.revisionId ?? meta.headRevisionId;
    if (revisionId === undefined) {
      throw new Error(`Drive file ${fileId} reports no head revision; a citation needs one`);
    }
    let bytes: Buffer;
    let exporter: string;
    let mediaType: string;
    if (exportTarget !== undefined) {
      // Google-native: the exporter is the converter and is named as such. Export does not take
      // a revision, so a requested revision must be the head, or the citation would lie.
      if (options.revisionId !== undefined && options.revisionId !== meta.headRevisionId) {
        throw new Error(
          `Drive file ${fileId}: a Google-native document can only be exported at its head revision ` +
            `(${meta.headRevisionId ?? 'unknown'}), not ${options.revisionId}`,
        );
      }
      const response = await this.#get(
        `${base}/export?mimeType=${encodeURIComponent(exportTarget)}`,
      );
      bytes = Buffer.from(await response.arrayBuffer());
      exporter = `${DRIVE_EXPORTER} files.export mimeType=${exportTarget}`;
      mediaType = exportTarget;
    } else {
      const url =
        options.revisionId === undefined
          ? `${base}?alt=media&supportsAllDrives=true`
          : `${base}/revisions/${encodeURIComponent(options.revisionId)}?alt=media`;
      const response = await this.#get(url);
      bytes = Buffer.from(await response.arrayBuffer());
      exporter = `${DRIVE_EXPORTER} files.get alt=media`;
      mediaType = meta.mimeType;
    }
    return {
      fileId: meta.id,
      name: meta.name,
      sourceMimeType: meta.mimeType,
      revisionId,
      modifiedTime: meta.modifiedTime,
      webViewLink: meta.webViewLink,
      bytes,
      mediaType,
      exporter,
    };
  }
}

export function driveClientFromEnv(env: NodeJS.ProcessEnv): DriveClient | undefined {
  const path = env['KF_DRIVE_SERVICE_ACCOUNT_FILE'];
  if (path === undefined || path === '') return undefined;
  return new GoogleDriveClient(loadDriveServiceAccount(path));
}

/** Exists so a reviewer can grep that nothing here writes to Drive: read-only scope, GET only. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
