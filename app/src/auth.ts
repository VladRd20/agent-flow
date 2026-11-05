/**
 * Optional password gate for the standalone server.
 *
 * Enabled by setting AGENT_FLOW_PASSWORD_HASH (format produced by hashPassword:
 * `scrypt$<salt b64url>$<key b64url>`; generate with `agent-flow --hash-password`).
 * When unset, the server behaves exactly as before (no auth).
 *
 * Sessions are stateless signed cookies: `<expiry ms>.<HMAC-SHA256>`, keyed off the
 * stored hash, so changing the password invalidates every existing session.
 *
 * Direct loopback requests (no proxy headers) skip the gate so a local browser keeps
 * working. Requests arriving through a Cloudflare tunnel also come from loopback, but
 * carry Cf-Connecting-IP / X-Forwarded-For, so they are gated.
 */
import * as crypto from 'crypto'
import type * as http from 'http'

export const SESSION_COOKIE = 'af_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SCRYPT_KEYLEN = 32
const MAX_BODY_BYTES = 4096
const FAIL_WINDOW_MS = 15 * 60 * 1000
const MAX_FAILS = 10

export function hashPassword(password: string, salt: Buffer = crypto.randomBytes(16)): string {
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN)
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export function isValidPasswordHash(stored: string): boolean {
  const parts = stored.split('$')
  return parts.length === 3 && parts[0] === 'scrypt'
    && Buffer.from(parts[1], 'base64url').length > 0
    && Buffer.from(parts[2], 'base64url').length === SCRYPT_KEYLEN
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!isValidPasswordHash(stored)) return false
  const [, saltB64, keyB64] = stored.split('$')
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64url'), SCRYPT_KEYLEN)
  return crypto.timingSafeEqual(actual, Buffer.from(keyB64, 'base64url'))
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isProxied(req: http.IncomingMessage): boolean {
  return req.headers['cf-connecting-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined
}

/** True for a request made directly from this machine, not relayed by a proxy/tunnel. */
export function isDirectLocal(req: http.IncomingMessage): boolean {
  return LOOPBACK_ADDRS.has(req.socket.remoteAddress || '') && !isProxied(req)
}

function clientIp(req: http.IncomingMessage): string {
  const remote = req.socket.remoteAddress || ''
  // Only trust the proxy header when the proxy (cloudflared) is on this machine.
  if (LOOPBACK_ADDRS.has(remote)) {
    const cf = req.headers['cf-connecting-ip']
    if (typeof cf === 'string' && cf) return cf
  }
  return remote
}

function isHttps(req: http.IncomingMessage): boolean {
  return req.headers['x-forwarded-proto'] === 'https'
    || /"scheme":"https"/.test(String(req.headers['cf-visitor'] || ''))
}

function wantsHtml(req: http.IncomingMessage): boolean {
  return /text\/html/.test(String(req.headers.accept || ''))
}

const LOGIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Agent Flow · Sign in</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d12;
    font: 15px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; color: #e6e8ee; }
  form { width: min(320px, calc(100vw - 32px)); padding: 28px 24px; border-radius: 14px;
    background: #141821; border: 1px solid #232a38; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
  h1 { margin: 0 0 18px; font-size: 18px; font-weight: 600; letter-spacing: .01em; }
  input { box-sizing: border-box; width: 100%; padding: 11px 12px; border-radius: 9px; font: inherit;
    border: 1px solid #2c3446; background: #0e1118; color: inherit; outline: none; }
  input:focus { border-color: #5b8cff; }
  button { margin-top: 14px; width: 100%; padding: 11px; border: 0; border-radius: 9px; font: inherit;
    font-weight: 600; background: #5b8cff; color: #fff; cursor: pointer; }
  .err { margin: 0 0 12px; color: #ff7a7a; font-size: 13px; }
</style></head><body>
<form method="post" action="/login">
  <h1>Agent Flow</h1>
  ${error ? `<p class="err">${error}</p>` : ''}
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
</form></body></html>`
}

export interface AuthGate {
  /**
   * Returns true when the request was fully handled here (login/logout routes or a
   * rejection); false when it is authenticated and should continue to the app.
   */
  handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean
}

export function createAuthGate(passwordHash: string, now: () => number = Date.now): AuthGate {
  const key = crypto.createHash('sha256').update('agent-flow-session\0' + passwordHash).digest()
  const fails = new Map<string, number[]>()

  const sign = (exp: number) => crypto.createHmac('sha256', key).update(String(exp)).digest('base64url')

  function validSession(req: http.IncomingMessage): boolean {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (!token) return false
    const dot = token.indexOf('.')
    if (dot < 0) return false
    const exp = Number(token.slice(0, dot))
    if (!Number.isFinite(exp) || exp < now()) return false
    const given = Buffer.from(token.slice(dot + 1))
    const expected = Buffer.from(sign(exp))
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
  }

  function recentFails(ip: string): number[] {
    const cutoff = now() - FAIL_WINDOW_MS
    const list = (fails.get(ip) || []).filter((t) => t > cutoff)
    if (list.length) fails.set(ip, list)
    else fails.delete(ip)
    return list
  }

  function sendLogin(res: http.ServerResponse, status: number, error?: string) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': LOGIN_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    res.end(loginPage(error))
  }

  function redirect(res: http.ServerResponse, location: string, cookie?: string) {
    const headers: http.OutgoingHttpHeaders = { Location: location, 'Cache-Control': 'no-store' }
    if (cookie) headers['Set-Cookie'] = cookie
    res.writeHead(303, headers)
    res.end()
  }

  function cookieAttrs(req: http.IncomingMessage): string {
    return `Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`
  }

  function handleLoginPost(req: http.IncomingMessage, res: http.ServerResponse) {
    const ip = clientIp(req)
    if (recentFails(ip).length >= MAX_FAILS) {
      req.resume()
      sendLogin(res, 429, 'Too many attempts. Try again in a few minutes.')
      return
    }
    let size = 0
    let aborted = false
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      if (aborted) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' })
        res.end('Payload too large')
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      const password = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('password') || ''
      if (password && verifyPassword(password, passwordHash)) {
        fails.delete(ip)
        const exp = now() + SESSION_TTL_MS
        const cookie = `${SESSION_COOKIE}=${exp}.${sign(exp)}; Max-Age=${SESSION_TTL_MS / 1000}; ${cookieAttrs(req)}`
        console.log(`[auth] sign-in ok from ${ip}`)
        redirect(res, '/', cookie)
      } else {
        const list = recentFails(ip)
        list.push(now())
        fails.set(ip, list)
        console.warn(`[auth] failed sign-in from ${ip} (${list.length}/${MAX_FAILS})`)
        sendLogin(res, 401, 'Wrong password.')
      }
    })
  }

  return {
    handle(req, res, pathname) {
      const method = req.method || 'GET'

      if (pathname === '/login') {
        if (method === 'POST') { handleLoginPost(req, res); return true }
        if (method === 'GET' || method === 'HEAD') {
          if (isDirectLocal(req) || validSession(req)) redirect(res, '/')
          else sendLogin(res, 200)
          return true
        }
        res.writeHead(405, { Allow: 'GET, HEAD, POST' })
        res.end('Method not allowed')
        return true
      }

      if (pathname === '/logout') {
        redirect(res, '/login', `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`)
        return true
      }

      if (isDirectLocal(req) || validSession(req)) return false

      if ((method === 'GET' || method === 'HEAD') && pathname !== '/events' && wantsHtml(req)) {
        redirect(res, '/login')
      } else {
        res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
        res.end('Unauthorized')
      }
      return true
    },
  }
}
