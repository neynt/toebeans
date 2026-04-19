import { homedir } from 'os'
import { join } from 'path'

const AUTH_FILE = join(homedir(), '.toebeans', 'chatgpt-codex-auth.json')
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const SCOPES = 'openid profile email offline_access'

// refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000

interface StoredTokens {
  access_token: string
  refresh_token: string
  expires_at: number // unix ms
}

function generateRandom(length: number = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return base64url(bytes)
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64url(new Uint8Array(digest))
}

function base64url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function loadTokens(): Promise<StoredTokens | null> {
  const file = Bun.file(AUTH_FILE)
  if (!(await file.exists())) return null
  try {
    return await file.json() as StoredTokens
  } catch {
    return null
  }
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await Bun.write(AUTH_FILE, JSON.stringify(tokens, null, 2))
}

async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`token refresh failed (${res.status}): ${body}`)
  }

  const data = await res.json() as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  const tokens: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  }
  await saveTokens(tokens)
  return tokens
}

/**
 * ensure we have a valid access token. refreshes automatically if needed.
 * throws if no tokens are stored (user needs to run the auth flow).
 */
export async function getAccessToken(): Promise<string> {
  let tokens = await loadTokens()
  if (!tokens) {
    throw new Error(
      'not authenticated with ChatGPT. run: bun run scripts/auth-chatgpt-codex.ts'
    )
  }

  if (Date.now() >= tokens.expires_at - REFRESH_BUFFER_MS) {
    console.log('[chatgpt-codex] refreshing access token...')
    tokens = await refreshAccessToken(tokens.refresh_token)
    console.log('[chatgpt-codex] token refreshed')
  }

  return tokens.access_token
}

/**
 * run the full OAuth PKCE flow: open browser, handle callback, save tokens.
 */
export async function runOAuthFlow(): Promise<void> {
  const codeVerifier = generateRandom()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = generateRandom()

  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  })

  const authorizationUrl = `${AUTH_URL}?${authParams}`

  // wait for the callback with the authorization code
  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port: 1455,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/auth/callback') {
          const error = url.searchParams.get('error')
          if (error) {
            reject(new Error(`OAuth error: ${error}`))
            setTimeout(() => server.stop(), 100)
            return new Response(
              '<html><body><h1>Authentication failed</h1><p>You can close this tab.</p></body></html>',
              { headers: { 'Content-Type': 'text/html' } },
            )
          }

          const returnedState = url.searchParams.get('state')
          if (returnedState !== state) {
            reject(new Error(`OAuth state mismatch (expected ${state}, got ${returnedState})`))
            setTimeout(() => server.stop(), 100)
            return new Response(
              '<html><body><h1>Authentication failed</h1><p>State mismatch.</p></body></html>',
              { headers: { 'Content-Type': 'text/html' } },
            )
          }

          const authCode = url.searchParams.get('code')
          if (!authCode) {
            reject(new Error('no authorization code in callback'))
            setTimeout(() => server.stop(), 100)
            return new Response(
              '<html><body><h1>Missing code</h1></body></html>',
              { headers: { 'Content-Type': 'text/html' } },
            )
          }

          resolve(authCode)
          setTimeout(() => server.stop(), 100)
          return new Response(
            '<html><body><h1>Authenticated!</h1><p>You can close this tab and return to the terminal.</p></body></html>',
            { headers: { 'Content-Type': 'text/html' } },
          )
        }
        return new Response('not found', { status: 404 })
      },
    })

    console.log(`\nopen this URL in your browser to authenticate:\n\n${authorizationUrl}\n`)
    console.log('waiting for callback...')

    // try to open the browser automatically
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    Bun.spawn([openCmd, authorizationUrl], { stdout: 'ignore', stderr: 'ignore' })
  })

  // exchange authorization code for tokens
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`token exchange failed (${res.status}): ${body}`)
  }

  const data = await res.json() as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  await saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  })

  console.log('authentication successful! tokens saved.')
}
