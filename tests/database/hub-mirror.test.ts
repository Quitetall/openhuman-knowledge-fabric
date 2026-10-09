/**
 * CI fetches Docker Hub images through a mirror (ci.yml, KF_DOCKER_HUB_MIRROR). The rewrite must
 * never change WHICH bytes run: only a digest-pinned Docker Hub reference is rewritten.
 */
import { describe, expect, it } from 'vitest';
import { fromHubMirror } from './preservation-object-store.js';

const PINNED =
  'chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d';

describe('the Docker Hub mirror rewrite', () => {
  it('prefixes a digest-pinned Docker Hub image', () => {
    expect(fromHubMirror(PINNED, 'mirror.gcr.io')).toBe(`mirror.gcr.io/${PINNED}`);
  });
  it('leaves everything else alone', () => {
    expect(fromHubMirror(PINNED, undefined)).toBe(PINNED);
    expect(fromHubMirror(PINNED, '')).toBe(PINNED);
    expect(fromHubMirror('chrislusf/seaweedfs:4.48', 'mirror.gcr.io')).toBe(
      'chrislusf/seaweedfs:4.48',
    );
    const quay = `quay.io/keycloak/keycloak@sha256:${'a'.repeat(64)}`;
    expect(fromHubMirror(quay, 'mirror.gcr.io')).toBe(quay);
    const local = `localhost:5000/x@sha256:${'b'.repeat(64)}`;
    expect(fromHubMirror(local, 'mirror.gcr.io')).toBe(local);
  });
});
