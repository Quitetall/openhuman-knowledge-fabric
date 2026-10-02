import { lstatSync, readFileSync } from 'node:fs';
import { normalizedAbsolute, protectedPath } from '../embedding/runtime-inventory.mjs';

const KEYS = [
  'allowedPeerUids',
  'embeddingPort',
  'enginePath',
  'engineSha256',
  'format',
  'modelDirectory',
  'modelIdentity',
  'pythonRuntimeDirectory',
  'pythonRuntimeManifestSha256',
  'releaseDirectory',
  'releaseManifestSha256',
];
const PINS = ['engineSha256', 'pythonRuntimeManifestSha256', 'releaseManifestSha256'];
const PATHS = ['enginePath', 'modelDirectory', 'pythonRuntimeDirectory', 'releaseDirectory'];
const RECIPE_PATHS = [
  'scripts/retrieval/config.mjs',
  'scripts/retrieval/startup.mjs',
  'scripts/embedding/runtime-inventory.mjs',
  'scripts/embedding/verify-runtime.mjs',
  'scripts/embedding/launch-runtime.mjs',
  'scripts/embedding/model.py',
  'scripts/embedding/transport.py',
  'scripts/embedding/serve.py',
];

/** Pins for the executable startup recipe, extracted only from a separately authenticated manifest. */
export function recipePins(manifest) {
  const lines = manifest.split('\n');
  return RECIPE_PATHS.map((path) => {
    const entries = lines.filter((line) => line.slice(66) === path);
    if (entries.length !== 1 || !/^[0-9a-f]{64} {2}/.test(entries[0])) {
      throw new Error('startup_recipe_manifest_invalid');
    }
    return { path, sha256: entries[0].slice(0, 64) };
  });
}

/** Flat, non-secret startup contract. No arbitrary arguments, environment or key-file option. */
export function parseConfig(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8192)
    throw new Error('startup_config_invalid');
  const seen = new Set();
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
    const key = JSON.parse(`"${match[1]}"`);
    if (seen.has(key)) throw new Error('startup_config_duplicate_key');
    seen.add(key);
  }
  const value = JSON.parse(text);
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(KEYS) ||
    value.format !== 'kf-retrieval-startup-v1'
  )
    throw new Error('startup_config_shape_invalid');
  for (const key of PINS) {
    if (typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key])) {
      throw new Error('startup_config_pin_invalid');
    }
  }
  for (const key of PATHS) {
    if (typeof value[key] !== 'string') throw new Error('startup_config_path_invalid');
    normalizedAbsolute(value[key]);
  }
  if (
    !Number.isInteger(value.embeddingPort) ||
    value.embeddingPort < 1 ||
    value.embeddingPort > 65535 ||
    typeof value.modelIdentity !== 'string' ||
    !/^[A-Za-z0-9./@+_-]{1,256}$/.test(value.modelIdentity) ||
    !Array.isArray(value.allowedPeerUids) ||
    value.allowedPeerUids.length > 16 ||
    value.allowedPeerUids.some(
      (uid) => !Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffffffff,
    ) ||
    new Set(value.allowedPeerUids).size !== value.allowedPeerUids.length
  ) {
    throw new Error('startup_config_value_invalid');
  }
  return value;
}

export function readConfig(path) {
  protectedPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192 || (stat.mode & 0o777) !== 0o644) {
    throw new Error('startup_config_custody_invalid');
  }
  return parseConfig(readFileSync(path, 'utf8'));
}

export function engineArguments(config) {
  return [
    'kf-retrieval',
    'serve',
    '--socket',
    '/run/lamu-retrieval/retrieval.sock',
    '--store',
    '/var/lib/lamu-retrieval/index',
    '--key-release-socket',
    '/run/kf-retrieval-key/release.sock',
    '--kf-release-sha256',
    config.releaseManifestSha256,
    '--embedder',
    'serve',
    '--pin-embedder',
    config.modelIdentity,
    '--serve-url',
    `http://127.0.0.1:${config.embeddingPort}`,
    '--socket-mode',
    '660',
    ...config.allowedPeerUids.flatMap((uid) => ['--allow-uid', String(uid)]),
  ];
}
