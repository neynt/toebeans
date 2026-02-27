// shared services for toebeans plugins
// TTS and STT servers are persistent python processes communicating over unix sockets

export { unixRequest, isProcessAlive } from './unix-socket.ts'
export { ensureWhisperServer, transcribe, stopWhisperServer } from './stt.ts'
export { ensureTtsServer, speak, stopTtsServer, type TtsOptions } from './tts.ts'
