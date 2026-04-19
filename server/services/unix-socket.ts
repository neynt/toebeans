// shared unix socket HTTP client for toebeans services

import * as http from 'node:http'

/**
 * make an HTTP request over a unix domain socket.
 * used by TTS and STT services to communicate with their python servers.
 * pass an AbortSignal to cancel the request and free the connection.
 */
export function unixRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: string | Buffer,
  contentType?: string,
  signal?: AbortSignal,
): Promise<{ status: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {}
    if (body) {
      headers['Content-Type'] = contentType || 'application/json'
      headers['Content-Length'] = typeof body === 'string' ? Buffer.byteLength(body) : body.length
    }
    const options: http.RequestOptions = {
      socketPath,
      method,
      path,
      headers: body ? headers : undefined,
    }
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }))
    })
    req.on('error', (err) => {
      if (signal?.aborted) reject(new Error('request aborted'))
      else reject(err)
    })
    if (signal) {
      if (signal.aborted) { req.destroy(); reject(new Error('request aborted')); return }
      signal.addEventListener('abort', () => req.destroy(), { once: true })
    }
    if (body) req.write(body)
    req.end()
  })
}

/**
 * make a streaming HTTP request over a unix domain socket.
 * returns the response stream for incremental consumption (chunked transfer encoding).
 * pass an AbortSignal to cancel the request and destroy the stream.
 */
export function unixRequestStream(
  socketPath: string,
  method: string,
  path: string,
  body?: string | Buffer,
  contentType?: string,
  signal?: AbortSignal,
): Promise<{ status: number; stream: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {}
    if (body) {
      headers['Content-Type'] = contentType || 'application/json'
      headers['Content-Length'] = typeof body === 'string' ? Buffer.byteLength(body) : body.length
    }
    const options: http.RequestOptions = {
      socketPath,
      method,
      path,
      headers: body ? headers : undefined,
    }
    let response: http.IncomingMessage | null = null
    const req = http.request(options, (res) => {
      response = res
      resolve({ status: res.statusCode ?? 0, stream: res })
    })
    req.on('error', (err) => {
      if (signal?.aborted) reject(new Error('request aborted'))
      else reject(err)
    })
    if (signal) {
      if (signal.aborted) { req.destroy(); reject(new Error('request aborted')); return }
      signal.addEventListener('abort', () => { req.destroy(); response?.destroy() }, { once: true })
    }
    if (body) req.write(body)
    req.end()
  })
}

/**
 * check if a process is alive by sending signal 0.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * read a pidfile and kill the process if alive. cleans up the pidfile afterward.
 */
export async function killPidfile(pidfilePath: string): Promise<void> {
  try {
    const pidContent = await Bun.file(pidfilePath).text()
    const pid = parseInt(pidContent.trim(), 10)
    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      console.log(`killing process from pidfile ${pidfilePath} (pid ${pid})`)
      process.kill(pid, 'SIGTERM')
      // wait briefly for graceful shutdown, then force kill
      await new Promise(resolve => setTimeout(resolve, 2000))
      if (isProcessAlive(pid)) {
        process.kill(pid, 'SIGKILL')
      }
    }
  } catch {}
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(pidfilePath)
  } catch {}
}
