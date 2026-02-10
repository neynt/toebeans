import { loadConfig } from '../../server/config.ts'
import { listSessions } from '../../server/session.ts'

export default async function printLlmQuery() {
  const sessionId = process.argv[3]

  if (!sessionId) {
    console.error('usage: bun run debug print-llm-query <session-id>')
    console.error('\navailable sessions:')
    const sessions = await listSessions()
    for (const s of sessions.slice(0, 10)) {
      console.error(`  ${s.id}`)
    }
    process.exit(1)
  }

  const config = await loadConfig()
  const base = `http://localhost:${config.server.port}`

  const res = await fetch(`${base}/debug/${sessionId}`)
  if (!res.ok) {
    console.error(`server returned ${res.status} — is it running?`)
    process.exit(1)
  }

  console.log(await res.text())
}
