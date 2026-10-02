#!/usr/bin/env python3
"""Compose the pinned CPU adapter and bounded local embedding interface."""

import argparse
import os
from pathlib import Path
import signal
import sys
import threading

sys.dont_write_bytecode = True

from model import MODEL_NAME, load_model
from transport import EmbeddingServer


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8021)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('invalid port')
    # Offline mode is unconditional, not a caller-controlled opt-in.
    for name in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_PROGRESS_BARS',
                 'PYTHONDONTWRITEBYTECODE', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS',
                 'OPENBLAS_NUM_THREADS', 'TOKENIZERS_PARALLELISM'):
        os.environ[name] = 'false' if name == 'TOKENIZERS_PARALLELISM' else '1'
    server = None
    try:
        embedder = load_model(args.model_dir)
        server = EmbeddingServer(('127.0.0.1', args.port), embedder, MODEL_NAME)

        def stop(signum, frame):
            # shutdown must not run in serve_forever's own thread.
            threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        sys.stderr.write('embedding_ready\n')
        server.serve_forever()
        return 0
    except Exception:
        sys.stderr.write('embedding_startup_failed\n')
        return 1
    finally:
        if server is not None:
            server.server_close()


if __name__ == '__main__':
    sys.exit(main())
