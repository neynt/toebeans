#!/usr/bin/env python3
"""persistent whisper transcription server using faster-whisper.

listens on a unix socket, accepts audio data via POST, returns transcription.
model stays loaded in VRAM/RAM between requests.

usage:
  python whisper-server.py --socket ~/.toebeans/whisper.sock [--model large-v3] [--device cuda]

api:
  POST /transcribe  — multipart/form-data with 'audio' file field
                       returns {"text": "transcribed text"}
  GET  /health      — returns 200 if server is ready
"""

import argparse
import io
import os
import signal
import socket
import sys
import threading
import wave

import numpy as np
from faster_whisper import WhisperModel
from flask import Flask, jsonify, request

app = Flask(__name__)

model: WhisperModel | None = None
model_lock = threading.Lock()

INITIAL_PROMPT = (
    "commit, push, pull, git, merge, rebase, branch, repo, deploy, "
    "API, endpoint, TypeScript, JavaScript, Python, npm, Docker, "
    "Kubernetes, Claude, LLM"
)


def load_model(model_size: str, device: str, compute_type: str) -> WhisperModel:
    print(f"whisper-server: loading model {model_size} on {device} ({compute_type})...", flush=True)
    m = WhisperModel(model_size, device=device, compute_type=compute_type)
    print("whisper-server: model loaded!", flush=True)
    return m


def read_wav_bytes(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    """read wav bytes into float32 numpy array and sample rate."""
    buf = io.BytesIO(audio_bytes)
    with wave.open(buf, "rb") as wf:
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, sample_rate


def resample(samples: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    """resample audio using soxr if available, else scipy."""
    if from_rate == to_rate:
        return samples
    try:
        import soxr
        return soxr.resample(samples, from_rate, to_rate, quality="HQ")
    except ImportError:
        # fallback: linear interpolation (good enough for speech)
        ratio = to_rate / from_rate
        n_out = int(len(samples) * ratio)
        indices = np.arange(n_out) / ratio
        left = np.floor(indices).astype(int)
        right = np.minimum(left + 1, len(samples) - 1)
        frac = indices - left
        return samples[left] * (1 - frac) + samples[right] * frac


@app.route("/health", methods=["GET"])
def health():
    if model is None:
        return "not ready", 503
    return "ok", 200


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if model is None:
        return jsonify({"error": "model not loaded"}), 503

    # accept audio as file upload or raw body
    if "audio" in request.files:
        audio_bytes = request.files["audio"].read()
    else:
        audio_bytes = request.get_data()

    if not audio_bytes:
        return jsonify({"error": "no audio data"}), 400

    try:
        samples, sample_rate = read_wav_bytes(audio_bytes)
    except Exception as e:
        return jsonify({"error": f"failed to read audio: {e}"}), 400

    # resample to 16kHz if needed (faster-whisper expects 16kHz)
    if sample_rate != 16000:
        samples = resample(samples, sample_rate, 16000)

    # transcribe with model lock for thread safety
    with model_lock:
        segments, info = model.transcribe(
            samples,
            language="en",
            initial_prompt=INITIAL_PROMPT,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=200,
                speech_pad_ms=100,
            ),
        )
        text = " ".join(seg.text.strip() for seg in segments)

    return jsonify({"text": text, "language": info.language, "duration": info.duration})


def run_on_unix_socket(sock_path: str, pidfile: str | None):
    """run flask app on a unix domain socket."""
    # clean up stale socket
    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass

    # write pidfile
    if pidfile:
        with open(pidfile, "w") as f:
            f.write(str(os.getpid()))

    # create unix socket
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(sock_path)
    os.chmod(sock_path, 0o660)
    sock.listen(8)

    print(f"whisper-server: listening on {sock_path} (pid {os.getpid()})", flush=True)

    # handle SIGTERM gracefully
    def handle_sigterm(signum, frame):
        print("whisper-server: shutting down...", flush=True)
        try:
            os.unlink(sock_path)
        except FileNotFoundError:
            pass
        if pidfile:
            try:
                os.unlink(pidfile)
            except FileNotFoundError:
                pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_sigterm)
    signal.signal(signal.SIGINT, handle_sigterm)

    # use werkzeug's server with our pre-bound socket
    from werkzeug.serving import make_server

    server = make_server("", 0, app, fd=sock.fileno())
    server.serve_forever()


def main():
    global model

    parser = argparse.ArgumentParser(description="persistent whisper transcription server")
    parser.add_argument("--socket", required=True, help="unix socket path")
    parser.add_argument("--pidfile", help="write PID to this file")
    parser.add_argument("--model", default="large-v3", help="whisper model name (default: large-v3)")
    parser.add_argument("--device", default="auto", help="device: auto, cuda, cpu (default: auto)")
    parser.add_argument("--compute-type", default=None, help="compute type (default: float16 for cuda, int8 for cpu)")
    args = parser.parse_args()

    # auto-detect device
    device = args.device
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"

    compute_type = args.compute_type
    if compute_type is None:
        compute_type = "float16" if device == "cuda" else "int8"

    model = load_model(args.model, device, compute_type)
    run_on_unix_socket(args.socket, args.pidfile)


if __name__ == "__main__":
    main()
