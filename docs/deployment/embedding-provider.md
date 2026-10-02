# Local embedding provider

Implementation and public-input evidence, 2026-10-02. This is a retrieval
consumer module, not the PostgreSQL authority kernel or a workflow. Its Python
runtime is not yet a sealed, installed production release. It grants no access
and owns no records, promotion decisions, index, queue or durable content.

## Composition and interface

- [model.py](../../scripts/embedding/model.py) verifies the exact root-protected,
  closed model file set before importing ML libraries, tokenizes without
  truncation, validates the whole ask and infers each input in one canonical
  batch shape. Every returned vector is finite, normalized and 1,024-dimensional.
- [transport.py](../../scripts/embedding/transport.py) exposes only `GET /health`
  and `POST /v1/embeddings` on literal `127.0.0.1`. It bounds eight worker
  connections, reader deadlines, framing and body size; one inference is
  admitted, with no waiting inference queue. Failures disclose fixed codes,
  not input, arbitrary paths or exception messages.
- [serve.py](../../scripts/embedding/serve.py) composes those atoms, forces
  offline model loading, handles termination and emits fixed startup codes.
- [probe.py](../../scripts/embedding/probe.py) exercises the same wire interface
  with public English/French inputs. It uses no ML libraries or proxies and
  persists no vectors or text. Its summary contains only public model identity,
  checks, timing and a public-vector digest.

The model is BGE-M3 at the exact revision and file digests in
[retrieval runtime evidence](retrieval-runtime-evidence.md). The model name is
`BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181/dense-cls-f32-single-cpu3-v1`:
CPU float32, dense CLS, normalization, canonical single-input inference and
three inference threads. This is deliberately distinct from the fixture's
older identity. Never reuse a store pinned to the older recipe as this one;
LAMU must refuse the mismatch or rebuild its derived index under a new generation.
The eventual deployment inventory must additionally pin the complete toolchain.

Requests contain only `input` (one string or 1–64 strings) and optionally the
exact `model` name. The body limit is 16 MiB. The token limit is 8,192 **per
input, including special tokens**. An overflow rejects the whole ask before
any input reaches inference; it never truncates, substitutes or returns a
partial vector set. Unknown fields, duplicate JSON keys, nonfinite JSON,
wrong models, ambiguous framing and non-loopback listening are refused.

Reader lifetime is at most ten seconds. Inference lifetime is at most 285
seconds; expiration terminates the complete provider with status 75 rather
than leaving timed-out plaintext work running. The supervisor must impose
memory, swap, task, CPU, core-dump and restart limits. A valid input-size
envelope is not a throughput guarantee: a large multi-input ask may exceed
the time budget and must be retried through bounded smaller work, never
reported as complete. One full-limit input is measured below; 64 simultaneous
full-limit inputs are not qualified.

At connection capacity, the accepting thread sends the fixed busy response,
half-closes its output, and discards incoming bytes for at most 0.1 seconds
and `16 MiB + 64 KiB`. This is not a queued inference or another worker.
The earlier immediate close raced `http.client`'s separate header/body writes
and caused a broken pipe. The named regression retains a scheduler gap and
asserts receipt of the busy response, not merely a closed connection.

## Run and test

After the declared runtime and root-protected model are installed:

```sh
<declared-python> -B /opt/kf/scripts/embedding/serve.py \
  --model-dir /opt/kf-models/bge-m3-5617a9f61b02-f16 --port 8021
python3 -B /opt/kf/scripts/embedding/probe.py --port 8021
```

The probe's `--full-token-limit` also embeds the exact public full-limit
input. Run it only against an isolated provider with sufficient remaining
lifetime and resource budget. It is not a commissioning, disclosure-policy
or ranking-quality probe.

The ordinary repository gate runs:

```sh
pnpm exec vitest run tests/deployment/embedding-provider.test.ts
```

That wrapper executes 18 Python standard-library tests against the real HTTP,
parser, admission and deadline code with a synthetic inference adapter. No
model or model-quality claim comes from those tests. In separate owned copies,
plants admitting a one-token overflow, echoing an arbitrary refusal and
omitting the inference abort each failed a named test. The unplanted source
passed. The admission race itself was reproduced before its correction.

## Selected-VM evidence

- A one-thread full-limit probe reached the 300-second service-manager limit
  without producing a result. Its timeout remains recorded; no input or
  deadline was shortened or enlarged to hide it.
- A three-thread experiment with the same five-GiB maximum, four-GiB
  memory-high threshold, zero swap, 64 tasks, no cores, offline loading and
  read-only system/home protections completed an exact 8,192-token public
  input in 149.928 seconds. The vector passed dimension, finite and norm
  checks. The real tokenizer refused an 8,193-token ask before inference.
  Repeated short batches and single inputs produced identical bytes.
- The final CLI ran in a distinct transient module with a 300% CPU quota,
  loopback-only network policy and private runtime directory. The real HTTP
  probe passed: 64 short inputs, canonical batch/single repeatability,
  overflow and wrong-model refusal, 1,024-dimensional finite normalized
  vectors. It took 7.810 seconds. Its `fullTokenLimitObserved` is **false**;
  the full-limit evidence is the separate adapter experiment, not this HTTP run.
- The exact optimized LAMU candidate `a20e515`, SHA-256
  `e02e3bf7e66443f411c823b1da4b54fb8a7523a7582205ade02f8019dfc93a33`,
  probed that live provider through its ordinary `HttpServeEmbedder` and
  returned the new recipe identity. Developer settings were explicitly absent.
  No key, index, KF records or live engine were created.
- After the tests, the transient HTTP module reached its 300-second probe
  lifetime. Its supervisor stopped it with result `timeout`, and its runtime
  directory disappeared. The later explicit stop found it already collected;
  this is not proof of an operator-initiated normal stop or restart. Its journal
  contains startup/timeout messages and the fixed `embedding_ready` code, not
  request text. All five existing KF services stayed active. Their application
  release was not promoted or restarted.

The retained evidence directory is
`/mnt/4tb/kf-vm/evidence/embedding-provider-2026-10-02`. It includes the
failed initial full gate, passing gate after the admission correction,
named plants, red/green admission regression, model journal, HTTP summary
and LAMU identity probe. Earlier `/tmp` logs and tool handles disappeared;
their absence was not treated as a pass. The old three-thread process's
journal records status 120 but no final result, so the experiment was rerun
with journal output and retained evidence.

## Remaining deployment work

The [runtime assembler and verifier](embedding-runtime.md) now seal a
host-bound candidate's interpreter, copied package tree and declared native
libraries. Bind the Python, wheel, native-library and model inventories to the
actual production release, then
install dedicated provider/engine identities and supervision. Bind their
toolchains, model recipe and release pins to the actual startup configuration;
prove KF-held key release against the complete installed engine, permission
masks, recovery, restart and reboot. Prove representative mixed/long batches
and queue retry behaviour before claiming capacity. Provider execution,
synthetic wiring, a repository gate and a public model probe are distinct
from real-corpus relevance, host commissioning and independent qualification.
