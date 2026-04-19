# Telnyx Voice Audio Pipeline

Technical reference for the end-to-end audio pipeline in the toebeans telnyx-voice plugin.

## Overview

```
Phone (PSTN) ←→ Telnyx Cloud ←→ toebeans server ←→ Whisper / LLM / TTS
```

The pipeline is fully bidirectional: inbound speech is transcribed and fed to the LLM, and the LLM's text response is synthesized back to audio and streamed to the caller in real-time.

---

## 1. Inbound: Phone → Telnyx Cloud

The caller's voice enters via PSTN. Telnyx handles the telephony side (SIP, RTP, codec negotiation) and delivers events + media to us.

Two connections from Telnyx to toebeans:

| Connection | Protocol | Port (default) | Purpose |
|---|---|---|---|
| Webhook server | HTTPS POST | 8089 | Call lifecycle events (`call.initiated`, `call.answered`, `call.hangup`, `call.dtmf.received`) |
| Media WebSocket | WSS | 8090 | Bidirectional audio streaming |

## 2. Telnyx WebSocket Protocol

Telnyx connects to `wss://{publicHost}/media` (configured via `publicHost` in plugin config).

### Messages from Telnyx

```jsonc
// connection established
{ "event": "connected", "version": "1.0.0" }

// stream metadata (once per call)
{ "event": "start", "stream_id": "...", "start": {
    "call_control_id": "...",
    "media_format": { "encoding": "L16", "sample_rate": 8000, "channels": 1 }
  }
}

// audio frames (continuous during call)
{ "event": "media", "media": { "payload": "<base64 audio>" }, "stream_id": "..." }

// stream ended
{ "event": "stop", "stream_id": "..." }
```

### Messages to Telnyx

```jsonc
// send audio back to the caller
{ "event": "media", "media": { "payload": "<base64 audio>" } }
```

### Audio Format

Configured via `streamBidirectionalCodec` (default: `L16`). Options:

| Codec | Format | Bytes/sample | Notes |
|---|---|---|---|
| **L16** | 16-bit signed PCM, little-endian | 2 | Default. Despite RFC 3551 specifying big-endian for RTP L16, Telnyx's media streaming WebSocket delivers L16 as little-endian. |
| **PCMU** | G.711 mu-law | 1 | Decoded via ITU-T G.711 lookup table |
| **PCMA** | G.711 A-law | 1 | Decoded via ITU-T G.711 lookup table |

Sample rate: 8000 Hz (default, telephony standard) or 16000 Hz.

## 3. Inbound Audio Processing

### Voice Activity Detection (VAD)

The plugin runs its own energy-based VAD — not Whisper's internal VAD:

1. Compute RMS energy of each incoming audio chunk
2. Compare against `silenceEnergyThreshold` (default: 200)
3. If silence exceeds `silenceThresholdMs` (default: 700ms), trigger transcription
4. A 100ms interval timer also checks for silence (catches cases where no new audio arrives)

Non-silent audio chunks accumulate in `call.audioChunks`. If a transcription is already in progress, new chunks go into `call.pendingAudio` instead (processed after the current pipeline finishes).

### DTMF Detection

Dual detection:
- **Webhook-based**: Telnyx sends `call.dtmf.received` events
- **DSP-based**: Goertzel algorithm runs on every inbound audio frame, detecting the 8 DTMF frequencies (4 row + 4 column). Includes twist ratio check (row/column power within 4 dB) and energy ratio check (DTMF must carry >60% of signal energy) to reject false positives from speech.

Detected DTMF digits are queued as `[DTMF from {number}]: {digit}` messages to the agent.

## 4. Speech-to-Text (Whisper)

### Architecture

```
telnyx-voice plugin → (WAV over unix socket) → whisper-server.py → (JSON response)
```

- **Server**: `server/services/whisper-server.py` — Flask app on unix socket at `~/.toebeans/whisper.sock`
- **Model**: faster-whisper `large-v3-turbo` (default), kept loaded in VRAM
- **Client**: `server/services/stt.ts` — manages server lifecycle, sends HTTP requests over unix socket

### Data flow

1. Accumulated PCM chunks are concatenated into a single buffer
2. Chunks shorter than 0.5s are discarded (too short for useful transcription)
3. PCM is converted to a WAV buffer in memory:
   - PCMU/PCMA → decoded to 16-bit LE PCM first
   - **Upsampled from 8kHz to 16kHz** — critical because Whisper's internal VAD (Silero/pyannote) fails on 8kHz telephony audio
4. WAV sent via `POST /transcribe` to whisper-server over unix socket (`~/.toebeans/whisper.sock`)
5. Server reads WAV, converts to float32, resamples to 16kHz if needed (redundant for pre-upsampled audio, but safe)
6. Transcribed with `vad_filter=True`, `language="en"`, and a developer-oriented `initial_prompt` for vocabulary hints
7. Returns `{ text, language, duration }` as JSON

### Failure points
- Whisper server not started (auto-started on init, 120s startup timeout for model loading)
- Empty transcription from silent/noisy audio
- Server crash (process monitored, auto-restarted)

## 5. LLM Response

Transcribed text is queued as a user message to the toebeans agent:

```
[phone call from +15551234567]: <transcribed text>
```

The agent processes this through its normal message loop (Anthropic Claude by default). The response streams back token-by-token through the plugin's `output()` handler.

### Streaming text buffering

The output handler buffers streaming text and splits on sentence boundaries (`.!?\n`) to enable sentence-level TTS pipelining. Each complete sentence triggers TTS generation immediately, so the first sentence can start playing while the LLM is still generating the rest.

DTMF markers (`[DTMF: 123]`) in the response are parsed out and sent as actual DTMF tones via the Telnyx API between TTS segments.

## 6. Text-to-Speech (Qwen3-TTS)

### Architecture

```
telnyx-voice plugin → (JSON over unix socket) → TTS server (qwen3-tts) → (WAV response)
```

- **Server**: External Python process started via `~/.toebeans/plugins/tts/start.sh`, listens on `~/.toebeans/tts.sock`
- **Model**: Qwen3-TTS (12Hz, 1.7B params), output at 24kHz
- **Client**: `server/services/tts.ts` — manages lifecycle, health watchdog (15s interval, restarts after 3 consecutive failures)

### Data flow

1. `speak(text, opts)` sends `POST /tts` with JSON body to unix socket
2. Options: `language`, `instruct` (voice description), `seed` (for voice consistency), `temperature`
3. Server returns complete WAV buffer (24kHz, 16-bit PCM)
4. Streaming variant: `POST /tts/stream` yields raw PCM int16 LE chunks at 24kHz (not currently used in the voice pipeline — the non-streaming `speak()` is used instead)

### TTS configuration
- `voiceInstruct`: natural language voice description (e.g., "a warm female voice")
- `voiceSeed`: torch random seed for reproducible voice timbre
- `voiceTemperature`: sampling temperature (default 0.3, lower = more consistent)
- 30s timeout per request

### Failure points
- TTS server startup (up to 120s for model loading)
- TTS timeout (30s per sentence)
- Server health degradation (watchdog handles restart)

## 7. Outbound: Audio Back to Caller

### Resampling and encoding

The TTS output (24kHz WAV) must be converted to the call's codec:

1. **Extract PCM** from WAV headers
2. **Resample 24kHz → 8kHz** using windowed-sinc FIR filter (Blackman window, 33-tap kernel) with anti-aliasing to prevent frequency folding
3. **Encode** to the call's codec:
   - L16: already 16-bit LE, used as-is
   - PCMU: encode via G.711 mu-law table
   - PCMA: encode via G.711 A-law table

### Frame pacing

Audio is sent as 20ms frames over the WebSocket, paced to real-time:

1. Pad audio to exact frame boundary (avoids partial frames → clicks)
2. Frame size: `sampleRate * 20ms * bytesPerSample` (e.g., 320 bytes for 8kHz L16)
3. Each frame: base64-encode → JSON `{ event: "media", media: { payload: "..." } }`
4. **Absolute-time pacing**: each frame targets `startTime + frameIndex * 20ms`, preventing setTimeout drift accumulation
5. Jitter and drift are logged for diagnostics

### Sentence pipelining

TTS generation and frame sending are decoupled:

- **Generation** starts immediately for each sentence (concurrent — next sentence generates while previous plays)
- **Frame sending** is serialized through a promise chain (`call.ttsSending`) so sentences play back-to-back without gaps or overlap

## 8. Call Recording

When enabled (default: `recordCalls: true`):

- All inbound and outbound PCM chunks are captured separately
- On call end: merged into a stereo WAV (left = inbound/remote, right = outbound/local)
- Saved to `~/.toebeans/telnyx-voice/call-recordings/{YYYY-MM-DD}/call-{id}-{timestamp}.wav`
- Companion `.json` metadata file with call details, duration, format info
- Optional `retentionDays` for auto-cleanup

## Summary: Complete Round-Trip

```
1. Caller speaks into phone
2. PSTN → Telnyx cloud (SIP/RTP)
3. Telnyx → media WebSocket (base64 JSON, L16/PCMU/PCMA @ 8kHz)
4. Plugin: energy-based VAD detects end of speech (700ms silence)
5. Plugin: concatenate audio chunks → build 16kHz WAV in memory
6. Plugin → whisper.sock: POST /transcribe (WAV body)
7. Whisper: faster-whisper large-v3-turbo transcription → JSON text
8. Plugin: queue "[phone call from X]: text" to agent
9. Agent: LLM generates streaming text response
10. Plugin: buffer text, split on sentence boundaries
11. Per sentence: Plugin → tts.sock: POST /tts (JSON body)
12. TTS: Qwen3-TTS generates 24kHz WAV
13. Plugin: extract PCM, resample 24→8kHz (anti-aliased), encode to call codec
14. Plugin → media WebSocket: 20ms paced frames (base64 JSON)
15. Telnyx cloud → PSTN → caller hears the response
```

## Key Unix Sockets

| Socket | Service | Protocol |
|---|---|---|
| `~/.toebeans/whisper.sock` | faster-whisper (STT) | HTTP (Flask/Werkzeug) |
| `~/.toebeans/tts.sock` | Qwen3-TTS | HTTP |

Both services are managed as detached child processes with PID files, auto-started on demand, and killed on plugin shutdown.
