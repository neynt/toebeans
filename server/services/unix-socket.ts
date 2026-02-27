// shared unix socket HTTP client for toebeans services

import * as http from 'node:http'

/**
 * make an HTTP request over a unix domain socket.
 * used by TTS and STT services to communicate with their python servers.
 */
export function unixRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: string | Buffer,
  contentType?: string,
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
    req.on('error', reject)
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
