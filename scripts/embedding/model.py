"""Pinned local BGE adapter and canonical input policy; no durable text or vectors."""

from dataclasses import dataclass
import hashlib
import math
from pathlib import Path
import stat
from typing import Any, Callable

MODEL_REVISION = '5617a9f61b028005a4858fdac845db406aefb181'
MODEL_NAME = f'BAAI/bge-m3@{MODEL_REVISION}/dense-cls-f32-single-cpu3-v1'
MODEL_MANIFEST = 'ab6184aae20a30f215160e7d5a9d231cd5a94323f62f4d3501a316aa66354f9a'
MODEL_FILES = frozenset(('PROVENANCE.json', 'config.json', 'model.safetensors',
                         'sentencepiece.bpe.model', 'special_tokens_map.json',
                         'tokenizer.json', 'tokenizer_config.json'))
MAX_TOKENS = 8192
MAX_INPUTS = 64
DIMENSIONS = 1024
CPU_THREADS = 3


class Refusal(Exception):
    """A fixed public code, never a caller value or a library exception message."""


@dataclass(frozen=True)
class TokenInput:
    count: int
    value: Any


class CanonicalEmbedder:
    """Validate the whole ask, then infer each input in an invariant batch shape.

    The tokenizer must retain every token including model special tokens. The
    inference adapter receives exactly one already-tokenized input per call.
    This interface owns no request queue, cache, store, logger or authority.
    """

    def __init__(self, tokenize: Callable[[str], TokenInput],
                 infer: Callable[[TokenInput], list[float]], *,
                 dimensions: int = DIMENSIONS, max_tokens: int = MAX_TOKENS):
        self.tokenize = tokenize
        self.infer = infer
        self.dimensions = dimensions
        self.max_tokens = max_tokens

    def embed(self, texts: list[str]) -> list[list[float]]:
        if (not isinstance(texts, list) or not 0 < len(texts) <= MAX_INPUTS
                or not all(isinstance(text, str) for text in texts)):
            raise Refusal('invalid_input')
        prepared = []
        for text in texts:
            item = self.tokenize(text)
            if type(item.count) is not int or item.count < 1:
                raise Refusal('invalid_tokenization')
            if item.count > self.max_tokens:
                raise Refusal('input_token_limit')
            prepared.append(item)
        vectors = []
        for item in prepared:
            vector = self.infer(item)
            if (not isinstance(vector, list) or len(vector) != self.dimensions
                    or any(not isinstance(value, (int, float)) or isinstance(value, bool)
                           or not math.isfinite(value) for value in vector)
                    or abs(sum(value * value for value in vector) - 1.0) > 0.0001):
                raise Refusal('invalid_embedding')
            vectors.append(vector)
        return vectors


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def verify_model_tree(directory: Path) -> None:
    """Verify fixed content pins in root-protected, non-symlink storage before ML imports."""
    if not directory.is_absolute():
        raise Refusal('model_custody')
    for path in (directory, *directory.parents):
        metadata = path.lstat()
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0
                or metadata.st_mode & 0o022):
            raise Refusal('model_custody')
    if {entry.name for entry in directory.iterdir()} != MODEL_FILES | {'SHA256SUMS'}:
        raise Refusal('model_file_set')
    for name in (*sorted(MODEL_FILES), 'SHA256SUMS'):
        metadata = (directory / name).lstat()
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                or metadata.st_mode & 0o022):
            raise Refusal('model_custody')
    manifest = directory / 'SHA256SUMS'
    if manifest.stat().st_size > 8192 or _sha256(manifest) != MODEL_MANIFEST:
        raise Refusal('model_manifest')
    seen = set()
    for line in manifest.read_text('ascii').splitlines():
        digest, name = line.split('  ', 1)
        if name not in MODEL_FILES or name in seen or _sha256(directory / name) != digest:
            raise Refusal('model_digest')
        seen.add(name)
    if seen != MODEL_FILES:
        raise Refusal('model_file_set')


def load_model(directory: Path) -> CanonicalEmbedder:
    """CPU float32 dense CLS adapter, offline and one canonical input at a time."""
    verify_model_tree(directory)
    import torch
    from transformers import AutoModel, AutoTokenizer

    torch.set_num_threads(CPU_THREADS)
    torch.set_num_interop_threads(1)
    tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True,
                                             trust_remote_code=False)
    model = AutoModel.from_pretrained(directory, local_files_only=True,
                                     trust_remote_code=False, dtype=torch.float32).eval()

    def tokenize(text: str) -> TokenInput:
        batch = tokenizer(text, padding=False, truncation=False, verbose=False,
                          return_tensors='pt')
        return TokenInput(batch['input_ids'].shape[1], batch)

    @torch.inference_mode()
    def infer(prepared: TokenInput) -> list[float]:
        hidden = model(**prepared.value).last_hidden_state[:, 0]
        normalized = torch.nn.functional.normalize(hidden.float(), dim=-1)
        return normalized[0].tolist()

    return CanonicalEmbedder(tokenize, infer)
