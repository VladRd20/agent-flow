import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'
import { AddressInfo } from 'net'

import { createAuthGate, hashPassword, verifyPassword, isValidPasswordHash, SESSION_COOKIE } from './auth'

const PASSWORD = 'correct horse battery staple'
const HASH = hashPassword(PASSWORD)
let clock = Date.now()

let server: http.Server
let port = 0

before(async () => {
  const gate = createAuthGate(HASH, () => clock)
  server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split(/[?#]/, 1)[0]
    if (gate.handle(req, res, pathname)) return
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('app')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})
after(() => { server.close() })

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

// Every request carries Cf-Connecting-IP (like cloudflared does) unless `direct` is set.
function req(path: string, opts: { method?: string; body?: string; cookie?: string; accept?: string; direct?: boolean; ip?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { 'X-Forwarded-Proto': 'https' }
    if (!opts.direct) headers['Cf-Connecting-IP'] = opts.ip || '203.0.113.7'
    if (opts.cookie) headers.Cookie = opts.cookie
    if (opts.accept) headers.Accept = opts.accept
    if (opts.body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const r = http.request({ host: '127.0.0.1', port, path, method: opts.method || 'GET', headers }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    r.on('error', reject)
    if (opts.body !== undefined) r.write(opts.body)
    r.end()
  })
}

async function login(password = PASSWORD, ip?: string): Promise<Res> {
  return req('/login', { method: 'POST', body: new URLSearchParams({ password }).toString(), ip })
}

function cookieOf(res: Res): string {
  const set = res.headers['set-cookie']?.[0] || ''
  return set.split(';')[0]
}

test('hash format round-trips and rejects wrong/malformed input', () => {
  assert.ok(isValidPasswordHash(HASH))
  assert.ok(verifyPassword(PASSWORD, HASH))
  assert.ok(!verifyPassword('nope', HASH))
  assert.ok(!isValidPasswordHash('scrypt$abc'))
  assert.ok(!verifyPassword(PASSWORD, 'plain-text'))
})

test('direct localhost bypasses the gate', async () => {
  const r = await req('/', { direct: true })
  assert.equal(r.status, 200)
  assert.equal(r.body, 'app')
})

test('proxied browser navigation redirects to /login; API/SSE get 401', async () => {
  const page = await req('/', { accept: 'text/html' })
  assert.equal(page.status, 303)
  assert.equal(page.headers.location, '/login')
  assert.equal((await req('/events', { accept: 'text/html' })).status, 401)
  assert.equal((await req('/index.js')).status, 401)
})

test('login page renders with a strict CSP', async () => {
  const r = await req('/login')
  assert.equal(r.status, 200)
  assert.match(r.body, /type="password"/)
  assert.match(String(r.headers['content-security-policy']), /default-src 'none'/)
})

test('wrong password is 401 and sets no cookie', async () => {
  const r = await login('wrong', '198.51.100.1')
  assert.equal(r.status, 401)
  assert.equal(r.headers['set-cookie'], undefined)
})

test('right password issues a Secure HttpOnly cookie that unlocks the app', async () => {
  const r = await login()
  assert.equal(r.status, 303)
  const set = r.headers['set-cookie']?.[0] || ''
  assert.match(set, /HttpOnly/)
  assert.match(set, /SameSite=Lax/)
  assert.match(set, /Secure/)
  const ok = await req('/events', { cookie: cookieOf(r) })
  assert.equal(ok.status, 200)
})

test('tampered and expired cookies are rejected', async () => {
  const c = cookieOf(await login())
  const [name, value] = c.split('=')
  const [exp, sig] = value.split('.')
  assert.equal((await req('/', { cookie: `${name}=${Number(exp) + 1}.${sig}` })).status, 401)
  assert.equal((await req('/', { cookie: `${SESSION_COOKIE}=garbage` })).status, 401)
  const saved = clock
  clock = Number(exp) + 1
  try {
    assert.equal((await req('/', { cookie: c })).status, 401)
  } finally {
    clock = saved
  }
})

test('a session from a different password hash is rejected', async () => {
  const other = createAuthGate(hashPassword(PASSWORD))
  const c = cookieOf(await login())
  const fake = { headers: { cookie: c, 'cf-connecting-ip': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' }, method: 'GET' } as unknown as http.IncomingMessage
  let status = 0
  const res = { writeHead: (s: number) => { status = s }, end: () => {} } as unknown as http.ServerResponse
  assert.equal(other.handle(fake, res, '/'), true)
  assert.equal(status, 401)
})

test('repeated failures from one IP are rate-limited', async () => {
  const ip = '192.0.2.99'
  for (let i = 0; i < 10; i++) assert.equal((await login('bad', ip)).status, 401)
  assert.equal((await login(PASSWORD, ip)).status, 429)
  // other clients unaffected
  assert.equal((await login(PASSWORD, '192.0.2.100')).status, 303)
})

test('oversized login body is refused', async () => {
  const r = await req('/login', { method: 'POST', body: 'password=' + 'x'.repeat(5000), ip: '192.0.2.200' }).catch(() => ({ status: 413 } as Res))
  assert.equal(r.status, 413)
})

test('logout clears the cookie', async () => {
  const r = await req('/logout')
  assert.equal(r.status, 303)
  assert.match(r.headers['set-cookie']?.[0] || '', /Max-Age=0/)
})

test('failed-attempt map is bounded: oldest entries are evicted past the cap', async () => {
  const gate = createAuthGate(HASH, () => clock, 3)
  const srv = http.createServer((q, s) => {
    if (gate.handle(q, s, (q.url || '/').split(/[?#]/, 1)[0])) return
    s.writeHead(200); s.end('app')
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const p = (srv.address() as AddressInfo).port
  const post = (password: string, ip: string) => new Promise<number>((resolve, reject) => {
    const body = new URLSearchParams({ password }).toString()
    const r = http.request({ host: '127.0.0.1', port: p, path: '/login', method: 'POST',
      headers: { 'X-Forwarded-Proto': 'https', 'Cf-Connecting-IP': ip, 'Content-Type': 'application/x-www-form-urlencoded' } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    r.on('error', reject); r.end(body)
  })
  try {
    for (let i = 0; i < 10; i++) assert.equal(await post('bad', '198.51.100.1'), 401)
    assert.equal(await post(PASSWORD, '198.51.100.1'), 429) // locked out while tracked
    for (const ip of ['198.51.100.2', '198.51.100.3', '198.51.100.4']) assert.equal(await post('bad', ip), 401)
    // oldest entry evicted by the cap, so the first IP is no longer tracked
    assert.equal(await post(PASSWORD, '198.51.100.1'), 303)
    // recent entries still count: lockout semantics unchanged for tracked IPs
    for (let i = 0; i < 9; i++) await post('bad', '198.51.100.4')
    assert.equal(await post(PASSWORD, '198.51.100.4'), 429)
  } finally { srv.close() }
})
