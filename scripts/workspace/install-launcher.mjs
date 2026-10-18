#!/usr/bin/env node
// `pnpm kf:install-launcher`: put a "Knowledge Fabric" icon in the applications menu, once.
//
//   ~/.local/share/applications/knowledge-fabric.desktop     runs launcher.mjs from this checkout
//   ~/.local/share/icons/hicolor/scalable/apps/knowledge-fabric.svg
//   ~/.local/share/knowledge-fabric/launcher.json             the node and PATH to start it with
//
// The desktop session's PATH is usually narrower than a terminal's (pnpm, docker and psql may live
// where it does not look), so the PATH this command ran under is recorded, minus this run's own
// node_modules entries, and the launcher starts its service with it.
//
// `pnpm kf:install-launcher -- --uninstall` removes the three files; it touches no workspace.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

export function launcherFiles(home = homedir()) {
  const share = path.join(home, '.local', 'share');
  return {
    desktop: path.join(share, 'applications', 'knowledge-fabric.desktop'),
    icon: path.join(share, 'icons', 'hicolor', 'scalable', 'apps', 'knowledge-fabric.svg'),
    config: path.join(share, 'knowledge-fabric', 'launcher.json'),
  };
}

/** One argument of a desktop entry's Exec key, quoted per the Desktop Entry Specification. */
export function execArg(value) {
  return `"${value.replace(/["`$\\]/g, (c) => `\\${c}`)}"`;
}

export function desktopEntry({ node, launcher, icon }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Knowledge Fabric',
    "Comment=Your organization's documents and records",
    `Exec=${execArg(node)} ${execArg(launcher)}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Office;',
    'StartupNotify=false',
    '',
  ].join('\n');
}

export function recordedPath(envPath = '') {
  return envPath
    .split(':')
    .filter((entry) => entry !== '' && !entry.includes(`${path.sep}node_modules${path.sep}`))
    .filter((entry) => !entry.endsWith(`${path.sep}node_modules${path.sep}.bin`))
    .join(':');
}

async function main(argv) {
  const files = launcherFiles();
  if (argv.includes('--uninstall')) {
    for (const file of Object.values(files)) await rm(file, { force: true });
    process.stdout.write('Removed the Knowledge Fabric icon. No workspace was touched.\n');
    return 0;
  }
  if (!existsSync(path.join(REPO, 'node_modules', '.modules.yaml'))) {
    const installed = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: REPO,
      stdio: 'inherit',
      timeout: 20 * 60_000,
    });
    if (installed.status !== 0) return 1;
  }
  for (const file of Object.values(files)) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  await copyFile(path.join(HERE, 'knowledge-fabric.svg'), files.icon);
  await writeFile(
    files.config,
    `${JSON.stringify({ repo: REPO, node: process.execPath, path: recordedPath(process.env.PATH) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    files.desktop,
    desktopEntry({
      node: process.execPath,
      launcher: path.join(HERE, 'launcher.mjs'),
      icon: files.icon,
    }),
    { mode: 0o644 },
  );
  spawnSync('update-desktop-database', [path.dirname(files.desktop)], {
    stdio: 'ignore',
    timeout: 30_000,
  });
  process.stdout.write(
    'Installed. Click "Knowledge Fabric" in your applications menu to set it up and open it.\n',
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
