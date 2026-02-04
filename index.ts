#!/usr/bin/env bun

const command = process.argv[2]

if (command === 'server') {
  await import('./server/index.ts')
} else if (command === 'client') {
  await import('./client/cli.ts')
} else {
  console.log(`toebeans - AI agent harness

Usage:
  bun run server    Start the server daemon
  bun run client    Start the CLI client

Or run directly:
  bun run index.ts server
  bun run index.ts client
`)
}
