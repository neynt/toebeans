# kitten-tts

Text-to-speech plugin using [KittenTTS](https://github.com/KittenML/KittenTTS) — a fast, CPU-only TTS engine with 8 built-in voices.

## Setup

Create the Python venv in this directory:

```bash
cd plugins/kitten-tts
python3 -m venv venv
source venv/bin/activate
pip install flask werkzeug soundfile kittentts
```

The ONNX model (~small) is downloaded from Hugging Face on first use. The `espeakng_loader` dependency bundles its own espeak-ng, so no system espeak installation is needed.

## Config

Add to `~/.toebeans/config.json5`:

```json5
{
  plugins: {
    'kitten-tts': {
      discordBotToken: '...',         // optional: for kitten_tts_send_voice
      defaultVoice: 'expr-voice-2-f', // optional: default voice
    }
  }
}
```

## Voices

| Voice | Description |
|-------|-------------|
| `expr-voice-2-m` | Male voice 2 |
| `expr-voice-2-f` | Female voice 2 |
| `expr-voice-3-m` | Male voice 3 |
| `expr-voice-3-f` | Female voice 3 |
| `expr-voice-4-m` | Male voice 4 |
| `expr-voice-4-f` | Female voice 4 |
| `expr-voice-5-m` | Male voice 5 |
| `expr-voice-5-f` | Female voice 5 |

## Graceful degradation

If the KittenTTS server fails to start, the plugin degrades gracefully:

- Tool calls return a clear error (`kitten-tts server is unavailable`) instead of crashing the process
- Background retries with exponential backoff (5s → 60s cap) attempt to restart the server
- The main toebeans server continues running with all other plugins functional

## Tools

### `kitten_tts_speak`

Generate speech from text.

- `text` (string, required): text to speak
- `voice` (string, optional): one of the voices above (default: `expr-voice-2-f`)
- `speed` (number, optional): speed multiplier (1.0 = normal)

### `kitten_tts_send_voice`

Send an audio file to a Discord channel.

- `channel_id` (string, required): Discord channel ID
- `audio_path` (string, required): path to audio file
- `message` (string, optional): text to accompany audio

## Differences from the `tts` plugin (Qwen3-TTS)

| Feature | kitten-tts | tts (Qwen3) |
|---------|-----------|-------------|
| Device | CPU only | GPU (CUDA/ROCm) |
| Voices | 8 fixed (m/f pairs) | Freeform voice descriptions |
| Languages | English only | 11 languages |
| Streaming | No | Yes |
| Model size | Small (ONNX) | ~3.5GB |
| Startup time | Seconds | Minutes |
| Quality | Good for English | Higher quality, multilingual |
