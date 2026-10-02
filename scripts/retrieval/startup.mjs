#!/usr/bin/env node
/* global fetch, AbortSignal */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { digest, fileRecord, protectedPath } from '../embedding/runtime-inventory.mjs';
import { readConfig, engineArguments, recipePins } from './config.mjs';

/** Read only a bounded local public health reply; model readiness releases no key. */
export async function providerReady(config, timeoutMs = 60_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('startup_readiness_deadline_invalid');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.embeddingPort}/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
        redirect: 'error',
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('startup_health_absent');
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4096) throw new Error('startup_health_too_large');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (response.status === 200 && reply.status === 'ok' && reply.model === config.modelIdentity)
        return;
    } catch {
      /* Not ready, bounded body, wrong recipe or failed local connection. */
    }
    if (Date.now() < deadline) await setTimeout(Math.min(200, deadline - Date.now()));
  }
  throw new Error('startup_provider_unavailable');
}

function supervise(binary, args) {
  const child = spawn(binary, args, {
    stdio: 'inherit',
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: '/nonexistent',
      LAMU_SETTINGS: '/nonexistent/kf-retrieval-settings',
    },
  });
  const term = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', interrupt);
  child.on('error', () => {
    process.stderr.write('retrieval_startup_refused\n');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.removeListener('SIGTERM', term);
    process.removeListener('SIGINT', interrupt);
    process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 1);
  });
}

async function main() {
  try {
    const [mode, path, ...extra] = process.argv.slice(2);
    if (!['provider', 'engine'].includes(mode) || !path || extra.length)
      throw new Error('startup_usage_invalid');
    const config = readConfig(path);
    protectedPath(config.releaseDirectory);
    const manifest = join(config.releaseDirectory, 'SHA256SUMS');
    protectedPath(manifest);
    const manifestRecord = fileRecord(manifest);
    if (
      manifestRecord.size > 16 * 1024 * 1024 ||
      manifestRecord.sha256 !== config.releaseManifestSha256 ||
      fileURLToPath(import.meta.url) !==
        join(config.releaseDirectory, 'scripts/retrieval/startup.mjs')
    ) {
      throw new Error('startup_release_mismatch');
    }
    const manifestBytes = readFileSync(manifest);
    if (digest(manifestBytes) !== config.releaseManifestSha256)
      throw new Error('startup_release_changed');
    for (const entry of recipePins(manifestBytes.toString('utf8'))) {
      const path = join(config.releaseDirectory, entry.path);
      protectedPath(path);
      if (fileRecord(path).sha256 !== entry.sha256) throw new Error('startup_recipe_changed');
    }
    if (mode === 'provider') {
      supervise(process.execPath, [
        join(config.releaseDirectory, 'scripts/embedding/launch-runtime.mjs'),
        config.pythonRuntimeDirectory,
        config.pythonRuntimeManifestSha256,
        join(config.releaseDirectory, 'scripts/embedding'),
        config.modelDirectory,
        String(config.embeddingPort),
      ]);
    } else {
      protectedPath(config.enginePath);
      const engine = fileRecord(config.enginePath);
      if (
        engine.sha256 !== config.engineSha256 ||
        (engine.mode & 0o111) === 0 ||
        readFileSync('/proc/swaps', 'utf8').trim().split('\n').length !== 1
      ) {
        throw new Error('startup_engine_refused');
      }
      await providerReady(config);
      supervise(config.enginePath, engineArguments(config));
    }
  } catch {
    process.stderr.write('retrieval_startup_refused\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
