#!/usr/bin/env python3
"""persistent whisper transcription server using faster-whisper.

listens on a unix socket, accepts audio data via POST, returns transcription.
model stays loaded between requests. uses GPU when available, falls back to CPU.

usage:
  python whisper-server.py --socket ~/.toebeans/whisper.sock [--model large-v3-turbo] [--device auto]

api:
  POST /transcribe  — multipart/form-data with 'audio' file field
                       returns {"text": "transcribed text"}
  GET  /health      — returns 200 if server is ready
"""

import argparse
import ctypes
import glob
import io
import os
import signal
import socket
import sys
import threading
import wave

# pre-load CUDA libs from nvidia pip packages (e.g. nvidia-cublas-cu12) before
# ctranslate2 tries to dlopen them by bare name. without this, systems that have
# a different CUDA version installed system-wide (e.g. CUDA 13) will fail at
# inference time with "libcublas.so.12 not found" even though the pip package
# provides the lib in site-packages/nvidia/*/lib/.
def _preload_nvidia_libs():
    try:
        import site
        sp = site.getsitepackages()[0]
        nvidia_dir = os.path.join(sp, "nvidia")
        if not os.path.isdir(nvidia_dir):
            return
        for lib_dir in sorted(glob.glob(os.path.join(nvidia_dir, "*/lib"))):
            for so in sorted(glob.glob(os.path.join(lib_dir, "*.so.*"))):
                try:
                    ctypes.CDLL(so, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass
    except Exception:
        pass

_preload_nvidia_libs()

import numpy as np
from faster_whisper import WhisperModel
from flask import Flask, jsonify, request

app = Flask(__name__)

model: WhisperModel | None = None
model_lock = threading.Lock()
_model_name: str = "large-v3-turbo"  # set in main(), used for fallback reload

INITIAL_PROMPT = (
    "commit, push, pull, git, merge, rebase, branch, repo, deploy, "
    "API, endpoint, TypeScript, JavaScript, Python, npm, Docker, "
    "Kubernetes, Claude, LLM"
)


def load_model(model_size: str, device: str, compute_type: str) -> WhisperModel:
    """load whisper model, falling back to CPU if CUDA libs are missing at load time."""
    print(f"whisper-server: loading model {model_size} on {device} ({compute_type})...", flush=True)
    try:
        m = WhisperModel(model_size, device=device, compute_type=compute_type)
    except (RuntimeError, OSError) as e:
        if device != "cpu":
            print(f"whisper-server: {device} load failed ({e}), falling back to cpu/int8", flush=True)
            m = WhisperModel(model_size, device="cpu", compute_type="int8")
        else:
            raise
    print(f"whisper-server: model loaded on {m.model.device}!", flush=True)
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
    global model
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
        try:
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
        except RuntimeError as e:
            # CUDA libs can be "found" at load time but fail at inference time
            # (e.g. libcublas.so.12). Fall back to CPU and retry once.
            if model.model.device == "cpu":
                raise
            print(f"whisper-server: inference failed on GPU ({e}), reloading on cpu/int8", flush=True)
            model = load_model(_model_name, "cpu", "int8")
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
    global model, _model_name

    parser = argparse.ArgumentParser(description="persistent whisper transcription server")
    parser.add_argument("--socket", required=True, help="unix socket path")
    parser.add_argument("--pidfile", help="write PID to this file")
    parser.add_argument("--model", default="large-v3-turbo", help="whisper model name (default: large-v3-turbo)")
    parser.add_argument("--device", default="auto", help="device: auto, cuda, cpu (default: auto)")
    parser.add_argument("--compute-type", default=None, help="compute type (default: float16 for cuda, int8 for cpu)")
    args = parser.parse_args()

    # auto-detect device: ctranslate2 can report CUDA devices even when the
    # runtime libs (libcublas, etc.) aren't loadable, so treat detection errors
    # as "no usable GPU" rather than crashing.
    device = args.device
    if device == "auto":
        try:
            import ctranslate2
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except (RuntimeError, OSError) as e:
            print(f"whisper-server: CUDA detection failed ({e}), using cpu", flush=True)
            device = "cpu"

    compute_type = args.compute_type
    if compute_type is None:
        compute_type = "float16" if device == "cuda" else "int8"

    _model_name = args.model
    model = load_model(_model_name, device, compute_type)
    run_on_unix_socket(args.socket, args.pidfile)


if __name__ == "__main__":
    main()
