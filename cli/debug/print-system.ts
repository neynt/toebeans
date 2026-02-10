import { loadConfig } from '../../server/config.ts'

export default async function printSystem() {
  const config = await loadConfig()
  const base = `http://localhost:${config.server.port}`

  const res = await fetch(`${base}/debug/system`)
  if (!res.ok) {
    console.error(`server returned ${res.status} — is it running?`)
    process.exit(1)
  }

  console.log(await res.text())
}
