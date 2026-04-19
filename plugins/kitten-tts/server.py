#!/usr/bin/env python3
"""
kitten-tts http server for toebeans
listens on a unix socket and provides tts generation via POST /tts
uses KittenTTS (CPU-only, ONNX-based, 8 built-in voices)
"""

import os
import sys
import signal
import socket
import argparse
import tempfile
import atexit
import time
import logging
import logging.handlers
from pathlib import Path

import numpy as np
import soundfile as sf

# set up espeak-ng from bundled loader before importing kittentts
import espeakng_loader
os.environ.setdefault('PHONEMIZER_ESPEAK_LIBRARY', str(espeakng_loader.get_library_path()))
os.environ.setdefault('ESPEAK_DATA_PATH', str(espeakng_loader.get_data_path()))

from kittentts import KittenTTS
from flask import Flask, request, jsonify, send_file

# --- file logging setup ---

LOG_DIR = Path.home() / ".toebeans" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "kitten-tts-server.log"
LOG_MAX_BYTES = 10 * 1024 * 1024  # 10 MB
LOG_BACKUP_COUNT = 2

log = logging.getLogger("kitten-tts")
log.setLevel(logging.DEBUG)
_fh = logging.handlers.RotatingFileHandler(
    LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT,
)
_fh.setFormatter(logging.Formatter(
    "%(asctime)s %(levelname)-5s [%(threadName)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
))
log.addHandler(_fh)

SAMPLE_RATE = 24000

app = Flask(__name__)


@app.before_request
def _log_request():
    request._start_time = time.monotonic()
    text_preview = ""
    if request.is_json and request.json and 'text' in request.json:
        text_preview = f" text={request.json['text'][:50]!r}"
    log.info(">> %s %s%s", request.method, request.path, text_preview)


@app.after_request
def _log_response(response):
    duration_ms = (time.monotonic() - request._start_time) * 1000
    log.info("<< %s %s %d %.0fms", request.method, request.path,
             response.status_code, duration_ms)
    return response


parser = argparse.ArgumentParser(description='kitten-tts server')
parser.add_argument('--socket', type=str, required=True,
                    help='path to unix socket')
parser.add_argument('--pidfile', type=str, required=True,
                    help='path to pid file')
args = parser.parse_args()

SOCKET_PATH = args.socket
PIDFILE_PATH = args.pidfile


def cleanup():
    """remove socket and pidfile on exit"""
    for path in [SOCKET_PATH, PIDFILE_PATH]:
        try:
            os.unlink(path)
        except OSError:
            pass


def handle_signal(signum: int, frame: object) -> None:
    cleanup()
    sys.exit(0)


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)
atexit.register(cleanup)

# write pidfile
Path(PIDFILE_PATH).write_text(str(os.getpid()))

# load model (uses default nano model from HuggingFace, downloads on first use)
log.info("loading kitten-tts model...")
print("loading kitten-tts model...")
model = KittenTTS()
VOICES = model.available_voices
log.info("model loaded. available voices: %s", VOICES)
print(f"model loaded! voices: {VOICES}")


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "voices": VOICES,
    })


@app.route('/voices', methods=['GET'])
def voices():
    return jsonify({"voices": VOICES})


@app.route('/tts', methods=['POST'])
def tts():
    data = request.json
    if not data or 'text' not in data:
        return jsonify({"error": "missing 'text' field"}), 400

    text = data['text']
    voice = data.get('voice', VOICES[0])
    speed = float(data.get('speed', 1.0))

    if voice not in VOICES:
        return jsonify({
            "error": f"unknown voice: {voice!r}. available: {VOICES}",
        }), 400

    log.info("tts request: voice=%s speed=%.1f text_len=%d text=%r",
             voice, speed, len(text), text[:80])
    print(f"tts: voice={voice} speed={speed} text={text[:60]!r}")

    t0 = time.monotonic()
    tmp_path = None
    try:
        audio = model.generate(text, voice=voice, speed=speed)

        gen_time = time.monotonic() - t0
        duration_s = len(audio) / SAMPLE_RATE
        log.info("tts done: gen=%.2fs audio=%.1fs voice=%s text_len=%d",
                 gen_time, duration_s, voice, len(text))
        print(f"tts done in {gen_time:.2f}s ({duration_s:.1f}s audio)")

        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            tmp_path = tmp.name
        sf.write(tmp_path, audio, SAMPLE_RATE)

    except Exception as e:
        gen_time = time.monotonic() - t0
        log.error("tts error after %.2fs: %s", gen_time, e)
        print(f"tts error: {e}")
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        return jsonify({"error": str(e)}), 500

    response = send_file(tmp_path, mimetype='audio/wav', as_attachment=True,
                         download_name='output.wav')

    @response.call_on_close
    def cleanup_tmp():
        try:
            os.unlink(tmp_path)
        except Exception as e:
            print(f"failed to cleanup temp file: {e}")

    return response


if __name__ == '__main__':
    # clean up stale socket
    try:
        os.unlink(SOCKET_PATH)
    except OSError:
        pass

    # create unix socket and bind
    from werkzeug.serving import make_server
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(SOCKET_PATH)
    sock.listen(5)
    log.info("listening on unix socket: %s (pid=%d)", SOCKET_PATH, os.getpid())
    print(f"listening on unix socket: {SOCKET_PATH}")

    server = make_server('localhost', 0, app, fd=sock.fileno())
    server.serve_forever()
