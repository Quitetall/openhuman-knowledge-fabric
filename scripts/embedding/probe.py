#!/usr/bin/env python3
"""Public-input production-interface probe; no relevance, authority or host qualification."""

import argparse
import hashlib
import http.client
import json
import math
import sys
import time

sys.dont_write_bytecode = True

from model import DIMENSIONS, MODEL_NAME

MAX_RESPONSE = 4 * 1024 * 1024


def request(port, payload=None, path='/v1/embeddings', method='POST'):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=300)
    try:
        body = None if payload is None else json.dumps(payload, allow_nan=False)
        connection.request(method, path, body, {'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ValueError('probe_response_limit')
        return response.status, json.loads(raw)
    finally:
        connection.close()


def vectors(port, texts):
    status, body = request(port, {'model': MODEL_NAME, 'input': texts})
    assert status == 200 and body['model'] == MODEL_NAME
    assert len(body['data']) == len(texts)
    result = []
    for index, item in enumerate(body['data']):
        vector = item['embedding']
        assert item['index'] == index and len(vector) == DIMENSIONS
        assert all(isinstance(value, (float, int)) and not isinstance(value, bool)
                   and math.isfinite(value) for value in vector)
        assert abs(sum(value * value for value in vector) - 1) < 0.0001
        result.append(vector)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8021)
    parser.add_argument('--full-token-limit', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('invalid port')
    started = time.monotonic()
    try:
        status, health = request(args.port, path='/health', method='GET')
        assert status == 200 and health['model'] == MODEL_NAME
        texts = ['The supplier qualification record identifies provenance.',
                 'La mécanique orbitale décrit les trajectoires des satellites.']
        batch = vectors(args.port, texts)
        assert batch[0] == vectors(args.port, [texts[0]])[0]
        assert batch == vectors(args.port, texts)
        repeated = vectors(args.port, [texts[0]] * 64)
        assert repeated == [batch[0]] * 64
        status, error = request(args.port, {'model': MODEL_NAME, 'input': [texts[0], 'x ' * 8191]})
        assert status == 400 and error['error']['code'] == 'input_token_limit'
        status, error = request(args.port, {'model': 'different-public-model', 'input': texts})
        assert status == 400 and error['error']['code'] == 'model_mismatch'
        if args.full_token_limit:
            assert len(vectors(args.port, ['x ' * 8190])[0]) == DIMENSIONS
        print(json.dumps({'scope': 'public_real_provider_interface_only', 'model': MODEL_NAME,
                          'dimensions': DIMENSIONS, 'maxInputCountObserved': 64,
                          'canonicalBatchAndSingleExact': True, 'overflowAndWrongModelRefused': True,
                          'fullTokenLimitObserved': args.full_token_limit,
                          'elapsedSeconds': round(time.monotonic() - started, 3),
                          'publicVectorDigest': hashlib.sha256(json.dumps(batch, separators=(',', ':'))
                                                               .encode()).hexdigest()}, sort_keys=True))
        return 0
    except Exception:
        sys.stderr.write('embedding_probe_failed\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())
