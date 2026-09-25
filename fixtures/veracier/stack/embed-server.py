#!/usr/bin/env python3
"""A loopback embedding server for the Véracier fixture's retrieval engine.

The engine (`lamu kf-retrieval serve --embedder serve`) embeds through an HTTP server speaking the
shape LAMU's `HttpServeEmbedder` probes: `GET /health` answers 2xx, and `POST /v1/embeddings`
with `{"input": [...]}` answers `{"model": ..., "data": [{"index": i, "embedding": [...]}]}`.
LAMU's own `lamu serve` fronts a `llama-server --embedding`, which this workstation does not have;
this is the smallest server that speaks the same two routes, and nothing else.

The model is BAAI/bge-m3 (MIT), dense output only: the [CLS] state of the last layer, L2
normalised, 1024 dimensions, up to 8192 tokens. It is multilingual (the fixture's documents are
French, English, German, Italian, Spanish and Arabic-script names) and symmetric (no query or
passage prefix), so a query and a document are embedded the same way.

Nothing leaves the host (KF-SAS-RQ-218): it binds 127.0.0.1 and refuses any other address, loads
the weights from a local directory with the Hub disabled, and keeps no text — a request is embedded
and answered, and neither the text nor the vector is written anywhere or logged.

    python3 embed-server.py prepare --source /mnt/2tb/models/bge-m3 --out ~/.local/share/kf-veracier/bge-m3-f16
    python3 embed-server.py serve --model-dir ~/.local/share/kf-veracier/bge-m3-f16 --port 8021

`prepare` runs once: it checks the Hub checkpoint (pytorch_model.bin, a pickle) against the
revision's published sha256, and writes the weights as float16 safetensors with the tokenizer and
a PROVENANCE.json naming the source revision and both digests. `serve` loads only that directory
and checks the safetensors digest against PROVENANCE.json. The reason is load time on a busy
workstation: unpickling 2.3 GB from a contended disk took minutes and looked like a hang, while
1.1 GB of memory-mapped safetensors loads in seconds.

The served model name carries the Hub revision, so the engine's pinned embedder identity names the
exact weights: a different revision is a different identity, and the engine refuses its store.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import torch  # noqa: E402
from transformers import AutoModel, AutoTokenizer  # noqa: E402

MODEL_REPO = "BAAI/bge-m3"
MODEL_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
# sha256 of pytorch_model.bin at that revision (the Hub's LFS oid). Checked at startup.
WEIGHTS_SHA256 = "b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38"
MODEL_NAME = f"{MODEL_REPO}@{MODEL_REVISION[:12]}"
LICENCE = "MIT"
DESCRIPTION = "A loopback embedding server for the Véracier fixture's retrieval engine."
TOKENIZER_FILES = (
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "sentencepiece.bpe.model",
)
MAX_TOKENS = 8192
MAX_INPUTS = 64
MAX_BODY = 16 * 1024 * 1024


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class Embedder:
    def __init__(self, model_dir: Path, device: str) -> None:
        provenance = json.loads((model_dir / "PROVENANCE.json").read_text())
        if (
            provenance.get("repo") != MODEL_REPO
            or provenance.get("revision") != MODEL_REVISION
            or provenance.get("source_sha256") != WEIGHTS_SHA256
        ):
            raise SystemExit(f"{model_dir} was not prepared from {MODEL_NAME}")
        weights = model_dir / "model.safetensors"
        actual = file_sha256(weights)
        if actual != provenance.get("safetensors_sha256"):
            raise SystemExit(f"{weights} does not match PROVENANCE.json: sha256 {actual}")
        self.device = torch.device(device)
        dtype = torch.float16 if self.device.type == "cuda" else torch.float32
        self.tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
        model = AutoModel.from_pretrained(model_dir, local_files_only=True, dtype=dtype)
        self.model = model.to(self.device).eval()
        self.lock = threading.Lock()

    @torch.inference_mode()
    def embed(self, texts: list[str]) -> list[list[float]]:
        with self.lock:
            batch = self.tokenizer(
                texts,
                padding=True,
                truncation=True,
                max_length=MAX_TOKENS,
                return_tensors="pt",
            ).to(self.device)
            hidden = self.model(**batch).last_hidden_state[:, 0]
            vectors = torch.nn.functional.normalize(hidden.float(), dim=-1)
            return vectors.cpu().tolist()


def handler_for(embedder: Embedder) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "veracier-embed/1"

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            # The request line only; never a body.
            sys.stderr.write(f"{self.command} {self.path.split('?')[0]}\n")

        def reply(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def error(self, status: int, message: str) -> None:
            self.reply(status, {"error": {"message": message, "type": "invalid_request_error"}})

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self.reply(200, {"status": "ok", "model": MODEL_NAME})
            else:
                self.error(404, "not found")

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/v1/embeddings":
                self.error(404, "not found")
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                self.error(400, "body missing or too large")
                return
            try:
                request = json.loads(self.rfile.read(length))
            except ValueError:
                self.error(400, "body is not JSON")
                return
            requested = request.get("model")
            if requested not in (None, "", MODEL_NAME):
                self.error(400, f"this server embeds with {MODEL_NAME} only")
                return
            if "input_type" in request:
                self.error(400, "this model is symmetric; input_type is not accepted")
                return
            inputs = request.get("input")
            if isinstance(inputs, str):
                inputs = [inputs]
            if (
                not isinstance(inputs, list)
                or not 0 < len(inputs) <= MAX_INPUTS
                or not all(isinstance(text, str) for text in inputs)
            ):
                self.error(400, f"input must be a string or 1..{MAX_INPUTS} strings")
                return
            try:
                vectors = embedder.embed(inputs)
            except Exception as failure:  # noqa: BLE001 - reported, never the text
                self.error(500, f"embedding failed: {type(failure).__name__}")
                return
            self.reply(
                200,
                {
                    "object": "list",
                    "model": MODEL_NAME,
                    "data": [
                        {"object": "embedding", "index": index, "embedding": vector}
                        for index, vector in enumerate(vectors)
                    ],
                },
            )

    return Handler


def prepare(source: Path, out: Path) -> None:
    """Convert the Hub checkpoint to float16 safetensors, once, with its provenance."""
    from safetensors.torch import save_file

    weights = source / "pytorch_model.bin"
    actual = file_sha256(weights)
    if actual != WEIGHTS_SHA256:
        raise SystemExit(f"{weights} is not {MODEL_NAME}: sha256 {actual}")
    state = torch.load(weights, map_location="cpu", weights_only=True, mmap=True)
    tensors = {
        name: (tensor.half() if tensor.is_floating_point() else tensor).contiguous()
        for name, tensor in state.items()
    }
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "model.safetensors.tmp"
    save_file(tensors, str(tmp), metadata={"format": "pt"})
    tmp.rename(out / "model.safetensors")
    for name in TOKENIZER_FILES:
        shutil.copyfile(source / name, out / name)
    provenance = {
        "repo": MODEL_REPO,
        "revision": MODEL_REVISION,
        "licence": LICENCE,
        "source_file": "pytorch_model.bin",
        "source_sha256": WEIGHTS_SHA256,
        "conversion": "float16 safetensors (floating tensors cast, others kept)",
        "safetensors_sha256": file_sha256(out / "model.safetensors"),
    }
    (out / "PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n")
    sys.stderr.write(f"prepared {out}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=DESCRIPTION)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare", help="convert the Hub checkpoint once")
    prep.add_argument("--source", type=Path, required=True)
    prep.add_argument("--out", type=Path, required=True)
    serve = commands.add_parser("serve", help="serve embeddings on loopback")
    serve.add_argument("--model-dir", type=Path, required=True)
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8021)
    serve.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.source, args.out)
        return
    if args.host not in ("127.0.0.1", "::1", "localhost"):
        raise SystemExit("refusing a non-loopback bind: document text must not leave this host")
    embedder = Embedder(args.model_dir, args.device)
    server = ThreadingHTTPServer((args.host, args.port), handler_for(embedder))
    sys.stderr.write(f"serving {MODEL_NAME} on http://{args.host}:{args.port} ({args.device})\n")
    sys.stderr.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
