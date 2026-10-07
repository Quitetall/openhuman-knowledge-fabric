/**
 * The first host's access artifacts agree with each other (ADR 0039).
 *
 * The nginx template, the certificate renewal unit and the firewall ruleset are three files that
 * name the same paths, interface and port. Each pairing a host depends on is asserted here, and
 * the ruleset is parsed by nft itself (`nft -c` in an unprivileged network namespace), with a
 * planted syntax error that must be refused so the check is known to be able to fail.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const TEMPLATE = read('deploy/nginx/knowledge-fabric-tailnet.conf');
const RENEW = read('deploy/systemd/kf-tls-renew.service');
const TIMER = read('deploy/systemd/kf-tls-renew.timer');
const RULESET = 'deploy/nftables/knowledge-fabric-tailnet.nft';

describe('the certificate nginx serves is the one kf-tls-renew writes', () => {
  it('names the same two paths', () => {
    const certificates = new Set(
      [...TEMPLATE.matchAll(/^\s*ssl_certificate\s+(\S+);/gm)].map((m) => m[1]),
    );
    const keys = new Set(
      [...TEMPLATE.matchAll(/^\s*ssl_certificate_key\s+(\S+);/gm)].map((m) => m[1]),
    );
    expect([...certificates]).toEqual(['/etc/kf/tls/tailnet.crt']);
    expect([...keys]).toEqual(['/etc/kf/tls/tailnet.key']);
    expect(RENEW).toContain(
      '--cert-file /etc/kf/tls/tailnet.crt --key-file /etc/kf/tls/tailnet.key',
    );
    expect(RENEW).toMatch(/^ReadWritePaths=\/etc\/kf\/tls$/m);
  });

  it('renews as kf-tls, and only checks and reloads nginx with privileges', () => {
    expect(RENEW).toMatch(/^User=kf-tls$/m);
    const privileged = [...RENEW.matchAll(/^Exec\w+=\+(.*)$/gm)].map((m) => m[1]);
    expect(privileged).toEqual([
      '/usr/sbin/nginx -t -q',
      '/usr/bin/systemctl reload nginx.service',
    ]);
    // nginx -t before the reload: a configuration nginx refuses is never loaded.
    expect(RENEW.indexOf('nginx -t -q')).toBeLessThan(RENEW.indexOf('reload nginx.service'));
    expect(RENEW).toMatch(/^OnFailure=kf-alert@%n\.service$/m);
  });

  it('is scheduled daily, catches up after downtime, and declares how long it may be silent', () => {
    expect(TIMER).toMatch(/^X-KF-MaxSilenceSec=\d+$/m);
    expect(TIMER).toMatch(/^Persistent=true$/m);
    expect(TIMER).toMatch(/^OnCalendar=\*-\*-\* /m);
  });

  it('keeps every template listener on the tailnet address', () => {
    const listens = [...TEMPLATE.matchAll(/^\s*listen\s+([^;]+);/gm)].map((m) => m[1]!);
    expect(listens.length).toBeGreaterThan(3);
    for (const listen of listens) expect(listen, listen).toMatch(/^KF_TAILNET_ADDRESS:\d+/);
  });
});

describe('the firewall ruleset', () => {
  const ruleset = read(RULESET);

  it('drops by default and admits the public interface only to the transport the exposure check allows', () => {
    expect(ruleset).toMatch(/type filter hook input priority filter; policy drop;/);
    expect(ruleset).toContain('iifname "tailscale0" accept');
    const ports = [...ruleset.matchAll(/^\s*(tcp|udp) dport (\d+) accept/gm)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
    expect(ports).toEqual(['udp:41641']);
    // The same port public_exposure allows by default.
    expect(read('packages/operations/src/internal/commissioning/contracts.ts')).toContain(
      "publicListenAllowed: 'udp:41641'",
    );
  });

  const nft = '/usr/bin/nft';
  const unshare = '/usr/bin/unshare';
  const canParse =
    existsSync(nft) && existsSync(unshare) && spawnSync(unshare, ['-rn', 'true']).status === 0;

  it.skipIf(!canParse)('is accepted by nft, and a planted error is not', () => {
    const check = (path: string) =>
      spawnSync(unshare, ['-rn', nft, '-c', '-f', path], { encoding: 'utf8' });
    const good = check(join(ROOT, RULESET));
    expect(good.status, good.stderr).toBe(0);
    const directory = mkdtempSync(join(tmpdir(), 'kf-nft-'));
    try {
      const planted = join(directory, 'planted.nft');
      writeFileSync(planted, ruleset.replace('udp dport 41641 accept', 'udp dport 41641 acept'));
      expect(check(planted).status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
