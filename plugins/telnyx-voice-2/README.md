# telnyx-voice-2

real-time phone conversations via Telnyx voice API. ground-up rewrite of telnyx-voice with aggressive pipelining — LLM tokens stream directly into TTS as sentences complete.

## how it works

audio pipeline: **caller audio → VAD → whisper STT → agent (LLM streaming) → sentence-level TTS streaming → audio out**

every stage streams into the next. no waiting for completion.

- incoming audio is buffered until voice activity ends (silence detection), then transcribed via whisper
- LLM text tokens are accumulated and split into sentences/paragraphs as they arrive — each chunk is immediately streamed through TTS without waiting for the full response
- barge-in (caller speaks during agent response) cancels the entire pipeline instantly via AbortController + silence flush
- each phone call gets its own toebeans session (routed via `telnyx-voice-2:{callControlId}`)

### text normalization (v2.2)

before sending text to TTS, paragraph breaks (`\n\n`) are converted to `. ` and single newlines to spaces. this prevents the TTS model from stopping generation at paragraph boundaries. the streaming splitter also detects `\n\n` as a split point, so each paragraph gets its own TTS call for immediate playback.

## tools

| tool | description |
|------|-------------|
| `phone_call_v2` | make an outbound call. takes `to` (E.164), optional `purpose` and `initialMessage` |
| `phone_hangup_v2` | hang up an active call. omit `call_id` for most recent |
| `send_dtmf_v2` | send DTMF tones on active call. digits: 0-9, *, #, A-D, w/W for pauses |
| `phone_status_v2` | list active calls with phase and session info |

### DTMF in responses

embed `[DTMF: digits]` in text responses to send tones mid-speech. commas become `w` pauses. the agent waits for pending TTS to finish before sending tones.

## audio pipeline details

- **flush buffer**: 120ms (v2.2, up from 60ms in v2.1). first TTS chunk flushes immediately for minimum time-to-first-audio.
- **frame pacing**: 20ms frames sent to Telnyx with real-time pacing and drift tracking
- **codecs**: L16 (PCM16 LE), PCMU (mu-law), PCMA (a-law) at 8kHz or 16kHz
- **resampling**: 24kHz TTS output → call sample rate with windowed-sinc anti-aliasing filter
- **barge-in**: abort pipeline + 100ms silence flush to clear Telnyx jitter buffer
- **DTMF detection**: Goertzel DSP on every inbound audio frame (works even during agent speech)
- **recording**: stereo WAV (inbound left, outbound right) saved to `~/.toebeans/recordings/{date}/`

## config

```json5
{
  "telnyx-voice-2": {
    "apiKey": "KEY...",           // telnyx API key (required)
    "connectionId": "...",        // for outbound calls
    "fromNumber": "+1...",        // caller ID for outbound
    "publicHost": "example.com",  // public hostname for webhook/media URLs
    "webhookPort": 8091,          // webhook server port (default 8091)
    "mediaWsPort": 8092,          // media WebSocket port (default 8092)
    "streamBidirectionalCodec": "L16",  // L16 or PCMU (default L16)
    "sampleRate": 8000,           // 8000 or 16000 (default 8000)
    "silenceThresholdMs": 700,    // silence duration to trigger STT (default 700)
    "silenceEnergyThreshold": 200, // RMS energy threshold (default 200)
    "voiceInstruct": "...",       // voice design instruction for TTS
    "voiceSeed": 42,              // torch seed for consistent voice
    "voiceTemperature": 0.3,      // TTS sampling temperature (default 0.3)
    "model": "sonnet",            // LLM model (default sonnet)
    "recordCalls": true           // save call recordings (default true)
  }
}
```

## notes

- requires a running whisper STT server and qwen3-tts server (auto-started on first call)
- telnyx webhooks must be configured to point at `https://{publicHost}/webhook`
- the media WebSocket URL is `wss://{publicHost}/media`
- call recordings are stereo WAV files with inbound on left channel and outbound on right
