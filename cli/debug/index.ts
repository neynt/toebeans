#!/usr/bin/env bun

const command = process.argv[2]

if (!command) {
  console.log(`usage: bun run debug <command>

commands:
  print-llm-query <session-id>   show the raw LLM query for a session
  print-system                   show the system prompt
  list-sessions                  list available sessions
  analyze-system-prompt          token breakdown of the system prompt
  tail-session <session-id>      pretty-print session and tail for updates
  tail-all-sessions              tail all sessions simultaneously
`)
  process.exit(1)
}

switch (command) {
  case 'print-llm-query': {
    const mod = await import('./print-llm-query.ts')
    await mod.default()
    break
  }
  case 'print-system': {
    const mod = await import('./print-system.ts')
    await mod.default()
    break
  }
  case 'list-sessions': {
    const { listSessions } = await import('../../server/session.ts')
    const { formatLocalTime } = await import('../../server/time.ts')
    const sessions = await listSessions()
    for (const s of sessions) {
      console.log(`${s.id}  (last active: ${formatLocalTime(s.lastActiveAt)})`)
    }
    break
  }
  case 'analyze-system-prompt': {
    const mod = await import('./analyze-system-prompt.ts')
    await mod.default()
    break
  }
  case 'tail-session': {
    const mod = await import('./tail-session.ts')
    await mod.default()
    break
  }
  case 'tail-all-sessions': {
    const mod = await import('./tail-all-sessions.ts')
    await mod.default()
    break
  }
  default:
    console.error(`unknown command: ${command}`)
    process.exit(1)
}
