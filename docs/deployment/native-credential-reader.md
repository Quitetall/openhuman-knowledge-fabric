# Native credentials for TypeScript consumers

`loadSecret` and `readSecretFile` retain the owner-only permission rule for
ordinary files. A group-readable ordinary file is still refused. Setting
`CREDENTIALS_DIRECTORY` alone does not change that rule. Development inline
inputs retain their existing opt-in interface outside native custody.

Explicit `KF_SECRET_CUSTODY=systemd` selects the Linux native adapter. It
requires a canonical absolute path immediately inside the canonical
`CREDENTIALS_DIRECTORY`. Aliases, nested paths, outside files, inline fallback,
unsupported custody values and ordinary-file mode overrides refuse. The
direct path reader accepts an optional fourth environment argument; it defaults
to the process environment, covering checkpoint and preservation signing paths.
`loadSecret` passes its supplied environment to that same reader.

The checker is the fixed `tools/kf-credential-custody` in this module's enclosing
release, found from its physical module location so pnpm's nested deployment
layout is supported. No caller-supplied executable or environment override is
accepted. The executable must be singly linked, root-owned, executable and
neither set-id nor writable by group/other. Every ancestor must be a nonsymlink
root-owned directory not writable by group/other. Checker execution receives
only fixed PATH/LANG, the directory and credential name, a five-second timeout
and discarded output. Its values never enter child arguments or environment;
checker errors become `SecretRejected` with reason `custody_unavailable` and
no untrusted child diagnostics. The file is read only after successful checking.

Before invoking the checker or reading a value, the adapter also requires an
empty kernel swap inventory, a canonical unified cgroup path whose actual
`memory.swap.max` is `0`, and actual soft/hard core limits both `0`. Missing or
unverifiable process-memory metadata refuses. Native unit profiles therefore
need `MemorySwapMax=0`, `LimitCORE=0` and `ProcSubset=all`; declarations alone
are not enough. The TypeScript adapter reads values into process memory, not
into scratch files, so it requires no extra credential projection or TMPDIR.

The C checker, not a JavaScript reimplementation, verifies the actual read-only,
nosuid/nodev/noexec tmpfs mount, exact root ownership and modes, single regular
file link, named-service-UID ACL and closed credential size policy. This adapter
does not validate a database principal, provider capability, key algorithm or
key-custodian authority; downstream consumers retain those checks. Root is the
trusted custodian, not an adversary this mechanism isolates.

The additional application names are `checkpoint-signing-key` (1–4,096 bytes),
`s3-durable-secret-access-key` (1–8,192), `readiness-token` and
`master-record-link-secret` (32–8,192 each). Existing names and bounds are
unchanged. The production-predicate test checks both endpoints and adjacent
refusals for all seventeen names. Unknown names have no policy.

## Native runtime proof

On a Linux PID1 host with existing distinct `kf-api` and `kf-worker` accounts,
use a verified root-protected release containing the compiled reader and helper:

```bash
sudo node /opt/kf/scripts/deploy/test-native-secrets.mjs /opt/kf
```

The driver copies the actual compiled reader/helper bytes into root-protected
public fixture layouts, then exercises real PID1 credentials under the two
existing identities. Its 48 cases cover ordinary/direct path readers, shallow
and nested module locations, new purpose names and refusal/size controls. It
asserts actual unswapped cgroups, core limit zero, native 0440 mounts, terminal
exit and removed credential mounts, and refuses separate planted swap-limit
and core-limit failures. It creates no service-owned credential
projection and contacts no network/provider. Retained executable and volatile
fixtures contain public dummy values only. Signing placeholders are deliberately
not real keys: these cases prove custody/read semantics, not signing validity.

On 2026-10-03 the sealed `068b6c4dd458` reader rejected a real native credential
as `too_permissive` while its C checker accepted that same 0440 mount. The
corrected compiled reader passed the 48 cases on the VM. The 33 interface tests
add mocked helper-trust/path/process refusal evidence; they do not replace the
kernel proof. This is source/compiled-runtime evidence, not a sealed release,
actual encrypted-store delivery, production service activation, database login,
provider delivery, host commissioning or qualification. Seal and verify the
resulting release before deployment. The selected startup realm/delivery and
each consumer's exact installed bindings remain separate obligations.
