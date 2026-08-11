#!/usr/bin/env python3
from __future__ import annotations
import json, sys
from decimal import Decimal
from pathlib import Path
from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parent
instance_path = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "example-atlas-enclosure-project.json"
schema = json.loads((root / "knowledge-fabric.schema.json").read_text())
vocab = json.loads((root / "knowledge-fabric.vocabulary.json").read_text())
instance = json.loads(instance_path.read_text())
errors = sorted(Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER).iter_errors(instance), key=lambda e: list(e.absolute_path))
if errors:
    for err in errors:
        print("SCHEMA", "/".join(map(str, err.absolute_path)), err.message)
    raise SystemExit(1)

nodes = {n["node_id"]: n for n in instance["nodes"]}
if len(nodes) != len(instance["nodes"]):
    raise SystemExit("duplicate node_id")
for e in instance["edges"]:
    if e["source"] not in nodes or e["target"] not in nodes:
        raise SystemExit(f"dangling edge {e['edge_id']}")

# Financial invariants for the portable schema pack.
work_orders = {n["node_id"]: n for n in nodes.values() if n["node_type"] == "work_order"}
acceptances = [n for n in nodes.values() if n["node_type"] == "acceptance_record"]
invoices = [n for n in nodes.values() if n["node_type"] == "invoice"]
payments = [n for n in nodes.values() if n["node_type"] == "payment"]
accepted = {wo: Decimal("0") for wo in work_orders}
for a in acceptances:
    amt = a["attributes"].get("accepted_amount")
    if amt:
        accepted[a["attributes"]["work_order"]] += Decimal(amt["amount"])
for wo_id, wo in work_orders.items():
    ceiling = Decimal(wo["attributes"]["authorized_ceiling"]["amount"])
    if accepted[wo_id] > ceiling:
        raise SystemExit(f"accepted value exceeds authorization for {wo_id}")

invoice_balances = {}
for inv in invoices:
    total = Decimal(inv["attributes"]["total"]["amount"])
    line_total = sum(Decimal(x["amount"]) for x in inv["attributes"]["line_items"])
    if total != line_total:
        raise SystemExit(f"invoice line total mismatch for {inv['node_id']}")
    invoice_balances[inv["node_id"]] = total
for p in payments:
    amount = Decimal(p["attributes"]["amount"]["amount"])
    allocated = sum(Decimal(x["amount"]["amount"]) for x in p["attributes"]["allocations"])
    if allocated > amount:
        raise SystemExit(f"payment overallocated for {p['node_id']}")
    for x in p["attributes"]["allocations"]:
        invoice_balances[x["invoice"]] -= Decimal(x["amount"]["amount"])
for inv, balance in invoice_balances.items():
    if balance < 0:
        raise SystemExit(f"invoice overpaid {inv}")
print(f"OK: {len(nodes)} nodes, {len(instance['edges'])} edges, {len(instance['actions'])} actions")
