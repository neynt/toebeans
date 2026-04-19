#!/usr/bin/env bun

import { runOAuthFlow } from '../llm-providers/chatgpt-codex-auth.ts'

console.log('chatgpt codex oauth authentication')
console.log('===================================\n')

try {
  await runOAuthFlow()
} catch (err) {
  console.error('authentication failed:', err)
  process.exit(1)
}
