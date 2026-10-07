import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validServiceName } from './internal/commissioning/unit-composition.js';
import {
  absolutePath,
  configuredInstances,
  parseSystemdProperties,
  probeName,
  SYSTEMD_PROPERTIES,
  templateFor,
} from './internal/commissioning/systemd-observation.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const complete = () =>
  SYSTEMD_PROPERTIES.map((key) => `${key}=${key === 'Id' ? 'kf-api.service' : ''}`).join('\n') +
  '\n';
describe('the alert instance of a failed template instance (KF-WAR-0001 rehearsal)', () => {
  it('is a service name: OnFailure=kf-alert@%n.service of kf-notify@digest.service', () => {
    expect(validServiceName('kf-alert@kf-notify@digest.service.service')).toBe(true);
    expect(templateFor('kf-alert@kf-notify@digest.service.service', ['kf-alert@.service'])).toBe(
      'kf-alert@.service',
    );
  });
  it('and still refuses what is not one', () => {
    for (const name of [
      'kf-alert@bad name.service',
      '@x.service',
      'kf-alert@x.socket',
      'a/b.service',
    ]) {
      expect(validServiceName(name), name).toBe(false);
    }
  });
});
describe('bounded systemd observation parsing and template discovery', () => {
  it('parses complete machine records and no command/credential properties', () => {
    expect(parseSystemdProperties(complete() + '\n' + complete())).toHaveLength(2);
    expect(parseSystemdProperties(complete())[0]!.Id).toBe('kf-api.service');
  });
  it.each([
    ['omitted', () => complete().replace('User=\n', '')],
    ['duplicate', () => complete() + 'Id=kf-api.service\n'],
    ['unrequested', () => complete() + 'Environment=PUBLIC_FIXTURE_UNTRUSTED\n'],
    ['control', () => complete() + '\x00'],
    ['oversized value', () => complete().replace('User=', 'User=' + 'x'.repeat(16385))],
    ['oversized response', () => 'x'.repeat(4 * 1024 * 1024 + 1)],
    ['too many units', () => Array.from({ length: 257 }, complete).join('\n')],
  ])('refuses %s responses', (_name, text) => {
    expect(() => parseSystemdProperties(text())).toThrow();
  });
  it('discovers inactive base files and instance drop-in directories, but not unrelated units', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kf-manager-instance-'));
    roots.push(root);
    await writeFile(join(root, 'kf-alert@idle.service'), 'public fixture');
    await mkdir(join(root, 'kf-alert@configured.service.d'));
    await writeFile(join(root, 'unrelated@idle.service'), 'out of scope');
    await writeFile(join(root, 'kf-alert@.service'), 'template');
    expect(await configuredInstances([root, join(root, 'absent')], ['kf-alert@.service'])).toEqual([
      'kf-alert@configured.service',
      'kf-alert@idle.service',
    ]);
  });
  it('refuses malformed matching instance names and non-directory load paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kf-manager-invalid-instance-'));
    roots.push(root);
    await writeFile(join(root, 'kf-alert@bad name.service'), 'public fixture');
    await expect(configuredInstances([root], ['kf-alert@.service'])).rejects.toThrow();
    await expect(
      configuredInstances([join(root, 'kf-alert@bad name.service')], ['kf-alert@.service']),
    ).rejects.toThrow();
  });
  it('handles the socket-instance escape spelling without accepting path or argument injection', () => {
    expect(
      templateFor('kf-retrieval-key@1-127.0.0.1\\x3a1.service', ['kf-retrieval-key@.service']),
    ).toBe('kf-retrieval-key@.service');
    expect(probeName('kf-alert@.service')).toBe('kf-alert@kf-commissioning-probe.service');
    for (const path of ['relative', '/etc/../run', '/etc/systemd\n/system', '/etc/with space'])
      expect(absolutePath(path)).toBe(false);
  });
});
