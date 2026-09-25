#!/usr/bin/env python3
"""S4 driver: LAMU asked (as the persona) to compile from SourceRefs KF never retrieved for it.

Same owned-process setup as LAMU's kf_source.py (its run.py helpers, its llama-server + `lamu
serve` with a kf_source config), but instead of retrieving, each forged ref is compiled alone, so
LAMU's KfSource::read_exact issues POST /context-source/read for it and the refusal is recorded.

  s4_forged_read.py --harness-dir <lamu-rs/scripts/context-proof> --lamu <bin> --llama-server <bin>
      --model <gguf> --kf-url URL --token-file F --organization ORG --acting-role ROLE
      --classification C --refs <json file: [{label, adapter, record, revision, digest}]> --output DIR

Writes <output>/receipt.json (int07.s4-forged-read/v1). No text is involved: every forged read
is expected to be refused.
"""
import argparse, json, os, re, subprocess, sys, time
from pathlib import Path

p = argparse.ArgumentParser()
for flag in ("--harness-dir", "--lamu", "--llama-server", "--model", "--token-file", "--refs", "--output"):
    p.add_argument(flag, type=Path, required=True)
for flag in ("--kf-url", "--organization", "--acting-role", "--classification"):
    p.add_argument(flag, required=True)
p.add_argument("--expect", default="source_unavailable")
a = p.parse_args()
sys.path.insert(0, str(a.harness_dir.resolve()))
from run import Processes, digest, port, request, wait_health  # noqa: E402

root = a.output.resolve()
root.mkdir(mode=0o700, parents=True, exist_ok=False)
repo = a.harness_dir.resolve().parents[2]
refs = json.loads(a.refs.read_text())
binary, backend_bin = a.lamu.resolve(), a.llama_server.resolve()
receipt = {"schema": "int07.s4-forged-read/v1",
           "lamu_source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
           "binary_sha256": digest(binary.read_bytes()), "backend_sha256": digest(backend_bin.read_bytes()),
           "kf": {"url": a.kf_url, "organization": a.organization, "acting_role": a.acting_role,
                  "classification": a.classification},
           "expect": a.expect, "acceptance": "pending (owner or independent reviewer)",
           "reads": [], "checks": {}, "status": "fail"}
processes = Processes(root)
env = {k: os.environ[k] for k in ("PATH", "LANG", "LD_LIBRARY_PATH") if k in os.environ}
env.update(HOME=str(root), XDG_CONFIG_HOME=str(root / "config"), XDG_DATA_HOME=str(root / "data"),
           LAMU_REGISTRY=str(root / "registry.yaml"), LAMU_DB=str(root / "memory.db"),
           LAMU_SETTINGS=str(root / "settings.toml"), CUDA_VISIBLE_DEVICES="", LAMU_GPU_INDICES="",
           TOKIO_WORKER_THREADS="2")
(root / "registry.yaml").write_text("models: {}\n")
try:
    issued = subprocess.run([str(binary), "auth", "issue", "--user", "alice"], env=env, cwd=root,
                            capture_output=True, check=True, timeout=30)
    token = re.search(rb"(?m)^\s*(lamu_[0-9a-f]{64})\s*$", issued.stdout).group(1).decode()
    env.update(LAMU_API_TOKEN=token, LAMU_CONTEXT_TOKEN=token)
    bport = port()
    backend = processes.start("backend", [str(backend_bin), "-m", str(a.model.resolve()), "--host", "127.0.0.1",
                                          "--port", str(bport), "-ngl", "0", "--ctx-size", "4096", "--threads", "2",
                                          "--parallel", "1", "--no-warmup", "--log-disable"], env)
    wait_health(f"http://127.0.0.1:{bport}", backend)
    config = root / "context.json"
    config.write_text(json.dumps({
        "kf_source": {"endpoint": a.kf_url, "token_file": str(a.token_file.resolve()),
                      "organization": a.organization, "acting_role": a.acting_role,
                      "classification": a.classification},
        "journal_db": str(root / "journal.db"), "tenant": a.organization, "policy_revision": "v1",
        "static_principal": "alice",
        "backend": {"pid": backend.pid, "port": bport, "model_path": str(a.model.resolve())},
        "cache_capacity": 8, "journal_capacity": 64}))
    aport = port()
    base = f"http://127.0.0.1:{aport}"
    api = processes.start("api", [str(binary), "serve", "--port", str(aport)],
                          dict(env, LAMU_CONTEXT_CONFIG=str(config), LAMU_CONTEXT_URL=base))
    wait_health(base, api)
    call = lambda path, body=None: request(base, "/v1/context/" + path, body, token)
    status, info, _, _ = call("info")
    assert status == 200, info
    status, control, _, _ = call("controls", {"deadline_unix_ms": int(time.time() * 1000) + 280_000})
    assert status == 200, control
    for i, ref in enumerate(refs):
        source = {k: ref[k] for k in ("adapter", "record", "revision", "digest")}
        body = {"schema": "lamu.context-request/v1", "request_id": f"s4-forged-{i}",
                "task": "Answer from the provided context only.", "scope": info["scope"],
                "sources": [{"source": source, "required": True}], "constraints": [],
                "model": info["model"], "max_input_tokens": 3000, "control": control}
        status, value, raw, _ = call("compile", body)
        code = value.get("code") if isinstance(value, dict) else None
        # The refusal body names the request's own ids; everything else must be the same bytes.
        shape = {k: v for k, v in value.items() if k not in ("operation_id", "request_id")} if isinstance(value, dict) else None
        receipt["reads"].append({"label": ref["label"], "record": ref["record"], "compile_status": status,
                                 "refusal": code, "response_sha256": digest(raw),
                                 "response": value if status != 200 else "(not kept)",
                                 "shape_sha256": digest(json.dumps(shape, sort_keys=True).encode())})
    receipt["checks"]["every_forged_read_refused_as_expected"] = all(
        r["compile_status"] != 200 and r["refusal"] == a.expect for r in receipt["reads"])
    receipt["checks"]["refusals_indistinguishable_in_lamu"] = len(
        {(r["compile_status"], r["refusal"], r["shape_sha256"]) for r in receipt["reads"]}) == 1
    receipt["status"] = "pass" if all(receipt["checks"].values()) else "fail"
except Exception as error:
    receipt["failure_type"] = type(error).__name__
    receipt["failure_detail"] = str(error)[:400]
    raise
finally:
    processes.close()
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"status": receipt["status"], "receipt": str(root / "receipt.json")}))
