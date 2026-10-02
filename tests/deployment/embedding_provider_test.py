"""Interface tests use public synthetic tokens/vectors, never semantic qualification."""

import contextlib
import errno
import http.client
import io
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/embedding'))
from model import CanonicalEmbedder, Refusal, TokenInput, load_model
from transport import EmbeddingServer


class CanonicalTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def tokenize(text):
            return TokenInput(len(text.split()) + 2, text)

        def infer(prepared):
            self.calls.append(prepared.value)
            return [1.0, 0.0]

        self.embedder = CanonicalEmbedder(tokenize, infer, dimensions=2, max_tokens=4)

    def test_whole_batch_refuses_before_any_inference(self):
        with self.assertRaisesRegex(Refusal, '^input_token_limit$'):
            self.embedder.embed(['one', 'one two three'])
        self.assertEqual(self.calls, [])

    def test_exact_token_limit_is_not_clamped(self):
        self.assertEqual(self.embedder.embed(['one two']), [[1.0, 0.0]])
        self.assertEqual(self.calls, ['one two'])

    def test_inference_always_has_one_prepared_input(self):
        first = self.embedder.embed(['one', 'one two'])
        self.assertEqual(self.embedder.embed(['one'])[0], first[0])
        self.assertEqual(self.calls, ['one', 'one two', 'one'])

    def test_invalid_vector_is_refused(self):
        for vector in ([float('nan'), 0], [0, 0], [1], [2, 0]):
            with self.subTest(vector=vector):
                embedder = CanonicalEmbedder(lambda _: TokenInput(2, None), lambda _: vector,
                                            dimensions=2, max_tokens=4)
                with self.assertRaisesRegex(Refusal, '^invalid_embedding$'):
                    embedder.embed(['public'])

    def test_tokenizer_cannot_supply_an_invalid_count(self):
        for count in (0, -1, True, 3.5):
            embedder = CanonicalEmbedder(lambda _: TokenInput(count, None), lambda _: [1, 0],
                                        dimensions=2, max_tokens=4)
            with self.assertRaisesRegex(Refusal, '^invalid_tokenization$'):
                embedder.embed(['public'])

    def test_untrusted_model_storage_is_refused_before_ml_imports(self):
        with self.assertRaisesRegex(Refusal, '^model_custody$'):
            load_model(Path('relative-model'))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(Refusal, '^model_custody$'):
                load_model(Path(directory))
        self.assertNotIn('torch', sys.modules)


class ListenerLifecycleTests(unittest.TestCase):
    def test_closed_connection_does_not_prevent_immediate_restart(self):
        if not Path('/proc/net/tcp').exists():
            self.skipTest('Linux TCP lifecycle contract')
        adapter = CanonicalEmbedder(lambda _: TokenInput(2, None), lambda _: [1, 0],
                                   dimensions=2)
        server = EmbeddingServer(('127.0.0.1', 0), adapter, 'public-model')
        address = server.server_address
        client = socket.create_connection(address, timeout=2)
        accepted, _ = server.get_request()
        try:
            # The server actively closes first, just as its HTTP/1.0 reply does.
            # Complete both FIN directions so the old local address is in TIME_WAIT.
            accepted.shutdown(socket.SHUT_WR)
            self.assertEqual(client.recv(1), b'')
            client.shutdown(socket.SHUT_WR)
            self.assertEqual(accepted.recv(1), b'')
        finally:
            accepted.close()
            client.close()
            server.server_close()
        port = f'{address[1]:04X}'
        self.assertTrue(any(row.split()[1].endswith(':' + port) and row.split()[3] == '06'
                            for row in Path('/proc/net/tcp').read_text().splitlines()[1:]),
                        'fixture must exercise a real TIME_WAIT connection')
        restarted = EmbeddingServer(address, adapter, 'public-model')
        restarted.server_close()

    def test_address_reuse_does_not_admit_a_second_live_listener(self):
        adapter = CanonicalEmbedder(lambda _: TokenInput(2, None), lambda _: [1, 0],
                                   dimensions=2)
        server = EmbeddingServer(('127.0.0.1', 0), adapter, 'public-model')
        try:
            with self.assertRaises(OSError) as refusal:
                EmbeddingServer(server.server_address, adapter, 'public-model')
            self.assertEqual(refusal.exception.errno, errno.EADDRINUSE)
        finally:
            server.server_close()


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()

        def infer(prepared):
            self.calls.append(prepared.value)
            if prepared.value == 'hold':
                self.entered.set()
                self.release.wait(2)
            return [1.0, 0.0]

        self.adapter = CanonicalEmbedder(lambda text: TokenInput(len(text.split()) + 2, text),
                                        infer, dimensions=2, max_tokens=4)
        self.server = EmbeddingServer(('127.0.0.1', 0), self.adapter, 'public-model-v1',
                                      read_deadline=0.3, inference_deadline=3)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, body=None, path='/v1/embeddings', method='POST', raw=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        try:
            payload = json.dumps(body) if raw is None else raw
            connection.request(method, path, payload, {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_health_and_indexed_vectors_use_existing_interface(self):
        status, health = self.request(method='GET', path='/health')
        self.assertEqual(status, 200)
        self.assertEqual(health['model'], 'public-model-v1')
        status, body = self.request({'input': ['one', 'one two'], 'model': 'public-model-v1'})
        self.assertEqual(status, 200)
        self.assertEqual(body['model'], 'public-model-v1')
        self.assertEqual([item['index'] for item in body['data']], [0, 1])
        self.assertEqual([item['embedding'] for item in body['data']], [[1.0, 0.0]] * 2)

    def test_invalid_requests_never_reach_inference(self):
        cases = [([], 'invalid_request'), ({'input': []}, 'invalid_input'),
                 ({'input': [1]}, 'invalid_input'), ({'input': ['x'] * 65}, 'invalid_input'),
                 ({'input': 'one', 'model': 'other'}, 'model_mismatch'),
                 ({'input': 'one', 'input_type': 'query'}, 'unsupported_field'),
                 ({'input': 'one', 'truncate': True}, 'unsupported_field'),
                 ({'input': 'one two three'}, 'input_token_limit')]
        for request, code in cases:
            with self.subTest(code=code):
                status, body = self.request(request)
                self.assertEqual(status, 400)
                self.assertEqual(body['error']['code'], code)
        self.assertEqual(self.calls, [])

    def test_duplicate_keys_and_nonfinite_json_are_refused(self):
        for raw in ('{"input":"one","input":"two"}', '{"input":NaN}', '{'):
            status, body = self.request(raw=raw)
            self.assertEqual(status, 400)
            self.assertEqual(body['error']['code'], 'invalid_json')
        self.assertEqual(self.calls, [])

    def test_one_active_inference_refuses_concurrent_work(self):
        result = []
        thread = threading.Thread(target=lambda: result.append(self.request({'input': 'hold'})))
        thread.start()
        self.assertTrue(self.entered.wait(1))
        status, body = self.request({'input': 'one'})
        self.assertEqual(status, 503)
        self.assertEqual(body['error']['code'], 'embedding_busy')
        self.assertEqual(self.request(method='GET', path='/health')[0], 200)
        self.release.set()
        thread.join(2)
        self.assertEqual(result[0][0], 200)

    def test_bad_framing_and_oversized_body_close_without_reading_it(self):
        for framing in ('Content-Length: -1', 'Content-Length: 16777217',
                        'Content-Length: 1\r\nContent-Length: 1',
                        'Transfer-Encoding: chunked'):
            with self.subTest(framing=framing):
                sock = socket.create_connection(self.server.server_address, timeout=2)
                sock.sendall(('POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\n' + framing +
                              '\r\nContent-Type: application/json\r\n\r\n').encode())
                response = http.client.HTTPResponse(sock)
                response.begin()
                self.assertEqual(response.status, 400)
                self.assertIn(json.loads(response.read())['error']['code'],
                              ('invalid_framing', 'body_limit'))
                sock.close()

    def test_absolute_read_deadline_closes_a_slow_request(self):
        sock = socket.create_connection(self.server.server_address, timeout=1)
        try:
            sock.sendall(b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\n')
            time.sleep(0.5)
            self.assertEqual(sock.recv(1), b'')
        finally:
            sock.close()

    def test_eight_readers_refuse_a_ninth_without_a_new_waiter(self):
        self.server.read_deadline = 2
        sockets = []
        try:
            for _ in range(8):
                sock = socket.create_connection(self.server.server_address, timeout=2)
                sockets.append(sock)
                sock.sendall(b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\n')
            until = time.monotonic() + 1
            while self.server.connections._value != 0 and time.monotonic() < until:
                time.sleep(0.005)
            self.assertEqual(self.server.connections._value, 0)
            original_send = http.client.HTTPConnection.send
            def delayed_send(connection, data):
                original_send(connection, data)
                if isinstance(data, bytes) and data.startswith(b'POST '):
                    # Model the scheduler gap between http.client's header and body writes.
                    time.sleep(0.02)
            with mock.patch.object(http.client.HTTPConnection, 'send', delayed_send):
                status, body = self.request({'input': 'one'})
            self.assertEqual(status, 503)
            self.assertEqual(body['error']['code'], 'embedding_busy')
            self.assertEqual(self.calls, [])
        finally:
            for sock in sockets:
                sock.close()

    def test_unknown_routes_and_methods_have_named_refusals(self):
        for method, path, status in [('GET', '/private-text', 404),
                                     ('PUT', '/v1/embeddings', 405)]:
            actual, body = self.request(method=method, path=path)
            self.assertEqual(actual, status)
            self.assertIn('code', body['error'])

    def test_arbitrary_request_text_and_exception_messages_are_not_logged(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            self.request({'input': 'private marker', 'extra': 'private marker'})
            self.request(method='GET', path='/private-marker')
            def failure(_):
                raise RuntimeError('private marker')
            self.adapter.infer = failure
            status, body = self.request({'input': 'private marker'})
        self.assertEqual(status, 503)
        self.assertEqual(body['error']['code'], 'embedding_failed')
        self.assertNotIn('private marker', json.dumps(body))
        self.assertEqual(output.getvalue(), '')

    def test_unrecognized_adapter_refusals_cannot_echo_text(self):
        def failure(_):
            raise Refusal('private marker')
        self.adapter.infer = failure
        status, body = self.request({'input': 'public'})
        self.assertEqual(status, 503)
        self.assertEqual(body['error']['code'], 'embedding_failed')

    def test_inference_deadline_terminates_the_provider_not_just_the_request(self):
        module_dir = Path(__file__).resolve().parents[2] / 'scripts/embedding'
        program = '''
import http.client, json, threading, time
from model import CanonicalEmbedder, TokenInput
from transport import EmbeddingServer
def stuck(_):
    time.sleep(30)
    return [1.0, 0.0]
adapter = CanonicalEmbedder(lambda _: TokenInput(2, None), stuck, dimensions=2)
server = EmbeddingServer(('127.0.0.1', 0), adapter, 'public-model', inference_deadline=0.15)
threading.Thread(target=server.serve_forever, daemon=True).start()
connection = http.client.HTTPConnection(*server.server_address, timeout=2)
connection.request('POST', '/v1/embeddings', json.dumps({'input':'public'}),
                   {'Content-Type':'application/json'})
connection.getresponse()
'''
        completed = subprocess.run([sys.executable, '-c', program], cwd=module_dir,
                                   capture_output=True, timeout=3)
        self.assertEqual(completed.returncode, 75)
        self.assertEqual(completed.stdout, b'')
        self.assertEqual(completed.stderr, b'')

    def test_remote_binding_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'loopback'):
            EmbeddingServer(('0.0.0.0', 0), self.adapter, 'public-model-v1')


if __name__ == '__main__':
    unittest.main(verbosity=2)
