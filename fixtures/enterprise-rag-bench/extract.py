#!/usr/bin/env python3
"""EnterpriseRAG-Bench → a local document tree the fixture loader reads.

    python3 fixtures/enterprise-rag-bench/extract.py [--data /mnt/4tb/data/enterprise-rag-bench]
        [--target 50000] [--full]

Reads the Hugging Face parquet files (onyx-dot-app/EnterpriseRAG-Bench, MIT) under
<data>/hf/data/{questions,documents}/test.parquet and the generator's own index
(<data>/repo/generated_data/uuid_index.json: doc_id -> path in the source tree, which names the
Slack channel, the mailbox, the shared drive, the Confluence space ...). Writes

    <data>/docs/<source_type>/<doc_id>.md    each selected document's content, byte for byte
    <data>/manifest.jsonl                    one line per selected document, key order (key = doc_id, or
                                             doc_id~n for the n-th row of a repeated doc_id)
    <data>/questions.jsonl                   the 500 questions, as the parquet holds them
    <data>/selection.json                    how the selection was made, and its counts
    <data>/directory.json                    the generator's employee directory
                                             (generated_data/employee_directory.yaml), as JSON

The documents parquet is 1.4 GB in ONE row group; it is streamed in record batches of 2 000 rows
(peak RSS ~0.3 GB measured), never loaded whole.

Selection (deterministic, documented in the README): every document any question expects, plus
the documents with the smallest sha256("kf-erb-2026-09:" + doc_id) until `--target` documents in
all. A hash order is a uniform random sample that does not depend on the file's row order, so it
reproduces from the ids alone. `--full` selects every document (for a later scale run) and
writes manifest-full.jsonl / selection-full.json instead, which `load.mjs --full` reads.
"""

import argparse
import hashlib
import json
import os
import sys

import pyarrow.parquet as pq
import yaml

SEED = "kf-erb-2026-09:"
BATCH = 2000


def rank(doc_id: str) -> str:
    return hashlib.sha256((SEED + doc_id).encode()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.environ.get("KF_ERB_CORPUS", "/mnt/4tb/data/enterprise-rag-bench"))
    ap.add_argument("--target", type=int, default=50000)
    ap.add_argument("--full", action="store_true")
    args = ap.parse_args()
    data = args.data
    docs_parquet = os.path.join(data, "hf", "data", "documents", "test.parquet")
    questions_parquet = os.path.join(data, "hf", "data", "questions", "test.parquet")
    generated = os.path.join(data, "repo", "generated_data")
    index = json.load(open(os.path.join(generated, "uuid_index.json")))
    directory = yaml.safe_load(open(os.path.join(generated, "employee_directory.yaml")))
    with open(os.path.join(data, "directory.json"), "w") as out:
        json.dump(directory, out, indent=2, ensure_ascii=False, sort_keys=True)
        out.write("\n")

    questions = pq.read_table(questions_parquet).to_pylist()
    expected = {d for q in questions for d in q["expected_doc_ids"]}
    with open(os.path.join(data, "questions.jsonl"), "w") as out:
        for q in sorted(questions, key=lambda q: q["question_id"]):
            out.write(json.dumps(q, ensure_ascii=False, sort_keys=True) + "\n")

    # Pass 1: ids only.
    f = pq.ParquetFile(docs_parquet, pre_buffer=False)
    all_ids = []
    for batch in f.iter_batches(batch_size=BATCH * 10, columns=["doc_id"]):
        all_ids.extend(batch.column(0).to_pylist())
    total = len(all_ids)
    missing_expected = sorted(expected - set(all_ids))
    if args.full:
        selected = set(all_ids)
    else:
        rest = sorted((rank(d), d) for d in all_ids if d not in expected)
        need = max(0, args.target - len(expected))
        selected = set(expected) | {d for _, d in rest[:need]}

    # Pass 2: content of the selected documents only.
    rows = []
    seen = {}
    f = pq.ParquetFile(docs_parquet, pre_buffer=False)
    for batch in f.iter_batches(batch_size=BATCH, columns=["doc_id", "source_type", "title", "content"]):
        for r in batch.to_pylist():
            if r["doc_id"] not in selected:
                continue
            body = r["content"].encode("utf-8")
            # One doc_id occurs twice in the corpus with different content (two versions of a
            # ticket). Both are kept, as two documents answering to the same doc_id: the second
            # is `<doc_id>~2`.
            seen[r["doc_id"]] = seen.get(r["doc_id"], 0) + 1
            key = r["doc_id"] if seen[r["doc_id"]] == 1 else "%s~%d" % (r["doc_id"], seen[r["doc_id"]])
            rel = os.path.join("docs", r["source_type"], key + ".md")
            dest = os.path.join(data, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            digest = hashlib.sha256(body).hexdigest()
            if not (os.path.exists(dest) and os.path.getsize(dest) == len(body)):
                with open(dest + ".tmp", "wb") as fh:
                    fh.write(body)
                os.replace(dest + ".tmp", dest)
            rows.append({
                "key": key,
                "doc_id": r["doc_id"],
                "source_type": r["source_type"],
                "title": r["title"],
                "source_path": index.get(r["doc_id"]),
                "file": rel,
                "bytes": len(body),
                "sha256": digest,
                "expected": r["doc_id"] in expected,
            })
    rows.sort(key=lambda r: r["key"])
    suffix = "-full" if args.full else ""
    with open(os.path.join(data, "manifest%s.jsonl" % suffix), "w") as out:
        for r in rows:
            out.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")
    by_source = {}
    for r in rows:
        by_source[r["source_type"]] = by_source.get(r["source_type"], 0) + 1
    selection = {
        "rule": "every expected_doc_id of the 500 questions, plus the documents with the smallest "
                "sha256('%s' + doc_id) until the target" % SEED if not args.full else "every document",
        "seed": SEED,
        "target": None if args.full else args.target,
        "corpus_documents": total,
        "expected_documents": len(expected),
        "expected_missing_from_corpus": missing_expected,
        "selected": len(rows),
        "doc_ids_with_several_versions": sorted(d for d, n in seen.items() if n > 1),
        "by_source_type": dict(sorted(by_source.items())),
        "without_source_path": sum(1 for r in rows if r["source_path"] is None),
    }
    json.dump(selection, open(os.path.join(data, "selection%s.json" % suffix), "w"), indent=2, sort_keys=True)
    print(json.dumps(selection))
    return 0


if __name__ == "__main__":
    sys.exit(main())
