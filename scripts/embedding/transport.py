"""Bounded loopback embedding interface; only fixed codes are exposed on failure."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import socket
import threading
import time

from model import MAX_INPUTS, Refusal

MAX_BODY = 16 * 1024 * 1024
MAX_CONNECTIONS = 8
REJECTION_DRAIN_SECONDS = 0.1
REJECTION_DRAIN_BYTES = MAX_BODY + 64 * 1024
PUBLIC_REFUSALS = frozenset(('invalid_input', 'invalid_tokenization', 'input_token_limit',
                            'invalid_embedding'))


def _abort_inference() -> None:
    # Kill the complete provider rather than leave timed-out plaintext work running.
    # Its supervisor may restart it. The caller receives a failed connection, not a result.
    os._exit(75)


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_key')
        result[key] = value
    return result


def _invalid_constant(_):
    raise ValueError('nonfinite_json')


class EmbeddingServer(ThreadingHTTPServer):
    """Eight bounded connection readers, one inference, no waiting inference queue.

    Dependencies cross the same embed interface used by the pinned model adapter.
    Non-loopback listening is never admitted. Reader and inference deadlines are
    separate: a slow peer cannot keep a reader, and timed-out inference terminates
    this module. No request or exception message is written to a log.
    """

    daemon_threads = True
    block_on_close = False
    # SO_REUSEADDR permits restart over a closed connection's TIME_WAIT, not a
    # second live listener. No SO_REUSEPORT is enabled; production loopback is
    # additionally confined to the provider/engine's private namespace.
    allow_reuse_address = True
    request_queue_size = MAX_CONNECTIONS

    def __init__(self, address, embedder, model_name, *, read_deadline=10.0,
                 inference_deadline=285.0):
        if address[0] != '127.0.0.1':
            raise ValueError('embedding listener must be loopback')
        if not 0 < read_deadline <= 10 or not 0 < inference_deadline <= 285:
            raise ValueError('invalid embedding deadline')
        self.embedder = embedder
        self.model_name = model_name
        self.read_deadline = read_deadline
        self.inference_deadline = inference_deadline
        self.connections = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self.inference = threading.BoundedSemaphore(1)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            request.settimeout(0.1)
            try:
                body = b'{"error":{"code":"embedding_busy","type":"unavailable"}}'
                request.sendall(b'HTTP/1.0 503 Service Unavailable\r\nConnection: close\r\n'
                                b'Content-Type: application/json\r\nContent-Length: ' +
                                str(len(body)).encode() + b'\r\n\r\n' + body)
                # A read-side close while http.client sends its separate body write
                # resets the connection and loses the refusal. Half-close the reply,
                # then discard incoming bytes within an absolute time/byte budget.
                # This runs in the accepting thread: no new waiter or inference queue.
                request.shutdown(socket.SHUT_WR)
                until = time.monotonic() + REJECTION_DRAIN_SECONDS
                remaining_bytes = REJECTION_DRAIN_BYTES
                while remaining_bytes > 0:
                    remaining = until - time.monotonic()
                    if remaining <= 0:
                        break
                    request.settimeout(remaining)
                    discarded = request.recv(min(8192, remaining_bytes))
                    if not discarded:
                        break
                    remaining_bytes -= len(discarded)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()

    def handle_error(self, request, client_address):
        # BaseServer otherwise logs the complete exception, which may hold caller text.
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    server_version = 'kf-embedding/1'
    sys_version = ''

    def setup(self):
        self.request.settimeout(self.server.read_deadline)
        self.read_timer = threading.Timer(self.server.read_deadline, self.expire_reader)
        self.read_timer.daemon = True
        self.read_timer.start()
        super().setup()

    def expire_reader(self):
        try:
            self.request.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def finish(self):
        self.read_timer.cancel()
        super().finish()

    def log_message(self, format, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.refuse(code, 'invalid_http')

    def reply(self, status, payload):
        self.close_connection = True
        body = json.dumps(payload, allow_nan=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)

    def refuse(self, status, code):
        self.reply(status, {'error': {'code': code, 'type': 'unavailable' if status == 503
                                    else 'invalid_request_error'}})

    def do_GET(self):
        self.read_timer.cancel()
        if self.path != '/health':
            self.refuse(404, 'not_found')
            return
        self.reply(200, {'status': 'ok', 'model': self.server.model_name})

    def do_POST(self):
        if self.path != '/v1/embeddings':
            self.refuse(404, 'not_found')
            return
        lengths = self.headers.get_all('Content-Length', [])
        if (len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit()
                or len(lengths[0]) > 9 or self.headers.get_all('Transfer-Encoding')):
            self.refuse(400, 'invalid_framing')
            return
        length = int(lengths[0])
        if not 0 < length <= MAX_BODY:
            self.refuse(400, 'body_limit')
            return
        if self.headers.get_content_type() != 'application/json':
            self.refuse(400, 'invalid_content_type')
            return
        raw = self.rfile.read(length)
        self.read_timer.cancel()
        if len(raw) != length:
            self.refuse(400, 'invalid_framing')
            return
        try:
            payload = json.loads(raw.decode('utf-8'), object_pairs_hook=_json_object,
                                 parse_constant=_invalid_constant)
        except (ValueError, UnicodeError, RecursionError):
            self.refuse(400, 'invalid_json')
            return
        finally:
            del raw
        if not isinstance(payload, dict):
            self.refuse(400, 'invalid_request')
            return
        if set(payload) - {'input', 'model'}:
            self.refuse(400, 'unsupported_field')
            return
        if payload.get('model') not in (None, self.server.model_name):
            self.refuse(400, 'model_mismatch')
            return
        texts = payload.get('input')
        if isinstance(texts, str):
            texts = [texts]
        if (not isinstance(texts, list) or not 0 < len(texts) <= MAX_INPUTS
                or not all(isinstance(text, str) for text in texts)):
            self.refuse(400, 'invalid_input')
            return
        if not self.server.inference.acquire(blocking=False):
            self.refuse(503, 'embedding_busy')
            return
        deadline = threading.Timer(self.server.inference_deadline, _abort_inference)
        deadline.daemon = True
        deadline.start()
        try:
            vectors = self.server.embedder.embed(texts)
            self.reply(200, {'object': 'list', 'model': self.server.model_name,
                            'data': [{'object': 'embedding', 'index': index, 'embedding': vector}
                                     for index, vector in enumerate(vectors)]})
        except Refusal as refusal:
            code = str(refusal) if str(refusal) in PUBLIC_REFUSALS else 'embedding_failed'
            self.refuse(400 if code == 'input_token_limit' else 503, code)
        except Exception:
            self.refuse(503, 'embedding_failed')
        finally:
            deadline.cancel()
            self.server.inference.release()

    def do_PUT(self):
        self.refuse(405, 'method_not_allowed')

    do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = do_PUT
