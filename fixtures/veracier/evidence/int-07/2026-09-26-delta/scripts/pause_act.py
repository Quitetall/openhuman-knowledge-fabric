#!/usr/bin/env python3
"""Wait for a paused kf_source.py run to write compiled.json, perform one KF act, then release it.

  pause_act.py --output <run dir> --require-ref <record id> --log <file> -- <act command...>

The act runs with no shell and must exit 0; compiled.json must list --require-ref among the
compiled sources (the act has to touch a record that is actually in the package). Only ids,
statuses and the act's response (no record text) are logged. Then <run dir>/continue is created.
"""
import argparse, json, subprocess, sys, time
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--output", type=Path, required=True)
p.add_argument("--require-ref", required=True)
p.add_argument("--log", type=Path, required=True)
p.add_argument("--timeout", type=int, default=900)
p.add_argument("act", nargs=argparse.REMAINDER)
a = p.parse_args()
act = a.act[1:] if a.act and a.act[0] == "--" else a.act
deadline = time.monotonic() + a.timeout
compiled = a.output / "compiled.json"
while not compiled.exists():
    if time.monotonic() > deadline:
        sys.exit("no compiled.json")
    time.sleep(0.5)
time.sleep(0.5)
data = json.loads(compiled.read_text())
refs = [s.get("record") for s in data["sources"]]
with open(a.log, "a") as log:
    log.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} compiled package {data['package_id']} with {len(refs)} refs\n")
    if a.require_ref not in refs:
        log.write(f"required ref {a.require_ref} NOT in the package; releasing without acting\n")
        (a.output / "continue").touch()
        sys.exit(2)
    log.write(f"required ref {a.require_ref} is in the package; acting\n")
    log.flush()
    done = subprocess.run(act, stdout=log, stderr=log, timeout=120)
    log.write(f"act exit {done.returncode}\n")
(a.output / "continue").touch()
sys.exit(done.returncode)
