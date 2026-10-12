#!/usr/bin/env python3
"""Convert the pinned BGE-M3 Hub checkpoint into the provider's closed model directory, offline.

    <runtime>/bin/python3.13 -I -S prepare-model.py <site-packages> <source-dir> <out-dir>

Run once at installation, by scripts/deploy/provision-retrieval.sh, as the unprivileged embedding
account, never as root and never by the provider. The source directory holds the Hub files at
model.MODEL_REVISION, each already checked against deploy/retrieval/bge-m3.sources; this checks
the checkpoint's digest again before unpickling anything, and unpickles weights only
(`weights_only=True`). The output is float16 safetensors, the five tokenizer files byte for byte,
and PROVENANCE.json, exactly as the fixture stacks' `embed-server.py prepare` writes them, so the
result is the directory whose manifest model.MODEL_MANIFEST pins. The installer refuses the
output unless that manifest digest matches; this program is not what makes it trusted.
"""

import hashlib
import json
from pathlib import Path
import shutil
import sys

sys.dont_write_bytecode = True

SOURCE_FILE = 'pytorch_model.bin'
SOURCE_SHA256 = 'b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38'
TOKENIZER_FILES = ('config.json', 'tokenizer.json', 'tokenizer_config.json',
                   'special_tokens_map.json', 'sentencepiece.bpe.model')


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def prepare(source: Path, out: Path, revision: str) -> None:
    weights = source / SOURCE_FILE
    if _sha256(weights) != SOURCE_SHA256:
        raise SystemExit('model_source_digest')
    import torch
    from safetensors.torch import save_file

    state = torch.load(weights, map_location='cpu', weights_only=True, mmap=True)
    tensors = {
        name: (tensor.half() if tensor.is_floating_point() else tensor).contiguous()
        for name, tensor in state.items()
    }
    temporary = out / 'model.safetensors.tmp'
    save_file(tensors, str(temporary), metadata={'format': 'pt'})
    temporary.rename(out / 'model.safetensors')
    for name in TOKENIZER_FILES:
        shutil.copyfile(source / name, out / name)
    provenance = {
        'repo': 'BAAI/bge-m3',
        'revision': revision,
        'licence': 'MIT',
        'source_file': SOURCE_FILE,
        'source_sha256': SOURCE_SHA256,
        'conversion': 'float16 safetensors (floating tensors cast, others kept)',
        'safetensors_sha256': _sha256(out / 'model.safetensors'),
    }
    (out / 'PROVENANCE.json').write_text(json.dumps(provenance, indent=2) + '\n')


def main() -> int:
    if len(sys.argv) != 4:
        sys.stderr.write('model_prepare_usage\n')
        return 64
    site, source, out = (Path(argument) for argument in sys.argv[1:])
    sys.path.insert(0, str(site))
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from model import MODEL_REVISION

    if not source.is_dir() or not out.is_dir() or any(out.iterdir()):
        sys.stderr.write('model_prepare_paths\n')
        return 64
    prepare(source, out, MODEL_REVISION)
    sys.stderr.write('model_prepared\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
