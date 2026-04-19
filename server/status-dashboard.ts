/**
 * Status dashboard — standalone process on port 3030.
 * Proxies to the main toebeans server's /status endpoint.
 *
 * NOTE: The dashboard is also available at /dashboard on the main server.
 * This standalone version is useful for monitoring a remote server or when
 * you want the dashboard on a separate port.
 *
 * Usage: bun run server/status-dashboard.ts
 * Then open http://localhost:3030
 */

import { dashboardHtml } from './dashboard-html'

const MAIN_SERVER = process.env.TOEBEANS_URL ?? 'http://localhost:3000'
const PORT = parseInt(process.env.DASHBOARD_PORT ?? '3030', 10)

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // proxy /api/status to main server
    if (url.pathname === '/api/status') {
      try {
        const resp = await fetch(`${MAIN_SERVER}/status`)
        return new Response(resp.body, {
          status: resp.status,
          headers: { 'content-type': 'application/json' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: 'main server unreachable' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      }
    }

    // proxy /api/debug/system to main server
    if (url.pathname === '/api/debug/system') {
      try {
        const resp = await fetch(`${MAIN_SERVER}/debug/system`)
        return new Response(resp.body, {
          status: resp.status,
          headers: { 'content-type': 'text/plain' },
        })
      } catch (e) {
        return new Response('main server unreachable', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        })
      }
    }

    // proxy /api/sessions to main server
    if (url.pathname === '/api/sessions') {
      try {
        const resp = await fetch(`${MAIN_SERVER}/sessions`)
        return new Response(resp.body, {
          status: resp.status,
          headers: { 'content-type': 'application/json' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: 'main server unreachable' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      }
    }

    // proxy /api/session/:id/entries to main server
    const entriesMatch = url.pathname.match(/^\/api\/session\/(.+)\/entries$/)
    if (entriesMatch) {
      try {
        const resp = await fetch(`${MAIN_SERVER}/session/${entriesMatch[1]}/entries`)
        return new Response(resp.body, {
          status: resp.status,
          headers: { 'content-type': 'application/json' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: 'main server unreachable' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      }
    }

    // proxy /api/session/:id/stream (SSE) to main server
    const streamMatch = url.pathname.match(/^\/api\/session\/(.+)\/stream$/)
    if (streamMatch) {
      try {
        const resp = await fetch(`${MAIN_SERVER}/session/${streamMatch[1]}/stream`, {
          signal: req.signal,
        })
        return new Response(resp.body, {
          status: resp.status,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          },
        })
      } catch (e) {
        return new Response('data: {"error":"main server unreachable"}\n\n', {
          status: 502,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
    }

    // proxy /api/coding-session/:agent/:id/output to main server
    const codingMatch = url.pathname.match(/^\/api\/coding-session\/([^/]+)\/([^/]+)\/output$/)
    if (codingMatch) {
      try {
        const targetUrl = `${MAIN_SERVER}/coding-session/${codingMatch[1]}/${codingMatch[2]}/output${url.search}`
        const resp = await fetch(targetUrl)
        return new Response(resp.body, {
          status: resp.status,
          headers: { 'content-type': 'application/json' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: 'main server unreachable' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      }
    }

    // serve dashboard HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(dashboardHtml('/api/status', '/api'), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    return new Response('not found', { status: 404 })
  },
})

console.log(`status dashboard running at http://localhost:${PORT}`)
console.log(`proxying to main server at ${MAIN_SERVER}`)
