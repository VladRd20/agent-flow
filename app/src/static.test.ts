import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'
import { AddressInfo } from 'net'

import { resolveRequestPath, serveStatic } from './static'
import { parseArgs } from './args'

test('resolveRequestPath strips query/fragment and decodes', () => {
  assert.equal(resolveRequestPath('/index.js?v=1'), '/index.js')
  assert.equal(resolveRequestPath('/a%2Fb#x'), '/a/b')
  assert.equal(resolveRequestPath('/%zz'), null)
  assert.equal(resolveRequestPath('/a%00b'), null)
})

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(serveStatic)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      // Raw request so the client doesn't normalise traversal sequences
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => { server.close(); resolve({ status: res.statusCode ?? 0, body }) })
      })
      req.on('error', (e) => { server.close(); reject(e) })
      req.end()
    })
  })
}

test('serveStatic: index shell, traversal and bad encodings never leak files', async () => {
  assert.equal((await get('/')).status, 200)
  assert.equal((await get('/?x=1')).status, 200)
  assert.equal((await get('/%zz')).status, 400)
  for (const p of ['/../package.json', '/..%2f..%2fpackage.json', '/..%5c..%5cpackage.json', '/static.ts']) {
    const r = await get(p)
    assert.ok(r.status === 404 || r.status === 403, `${p} -> ${r.status}`)
  }
})

test('parseArgs rejects shell-unsafe --host values', () => {
  const orig = console.error
  console.error = () => {}
  try {
    assert.equal(parseArgs(['--host', '0.0.0.0']).host, '0.0.0.0')
    const bad = parseArgs(['--host', 'x" & calc & "'])
    assert.equal(bad.host, '127.0.0.1')
  } finally { console.error = orig }
})

test('serveStatic: sets Referrer-Policy and X-Frame-Options on shell and assets', async () => {
  for (const p of ['/', '/index.js']) {
    const h = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const server = http.createServer(serveStatic)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        http.get({ host: '127.0.0.1', port, path: p }, (res) => {
          res.resume()
          res.on('end', () => { server.close(); resolve(res.headers) })
        }).on('error', (e) => { server.close(); reject(e) })
      })
    })
    if (p === '/') {
      assert.equal(h['referrer-policy'], 'no-referrer')
      assert.equal(h['x-frame-options'], 'DENY')
    } else if (h['x-frame-options'] !== undefined) {
      assert.equal(h['referrer-policy'], 'no-referrer')
    }
  }
})

function getRaw(path: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(serveStatic)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => { server.close(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body }) })
      }).on('error', (e) => { server.close(); reject(e) })
    })
  })
}

import * as fsSync from 'fs'
import * as osSync from 'os'
import * as pathSync from 'path'
import { setWebviewDirForTest } from './static'

function withTempWebview(): string {
  const dir = fsSync.mkdtempSync(pathSync.join(osSync.tmpdir(), 'af-webview-'))
  fsSync.writeFileSync(pathSync.join(dir, 'index.js'), 'console.log(1)')
  setWebviewDirForTest(dir)
  return dir
}

test('serveStatic: assets carry an ETag and answer If-None-Match with 304, keeping private no-cache', async () => {
  const dir = withTempWebview()
  try {
  const first = await getRaw('/index.js?v=abc')
  assert.equal(first.status, 200)
  const etag = first.headers.etag
  assert.match(String(etag), /^"[0-9a-f]{16}"$/)
  assert.equal(first.headers['cache-control'], 'private, no-cache')
  const again = await getRaw('/index.js?v=abc', { 'If-None-Match': String(etag) })
  assert.equal(again.status, 304)
  assert.equal(again.body, '')
  assert.equal(again.headers['cache-control'], 'private, no-cache')
  const stale = await getRaw('/index.js', { 'If-None-Match': '"deadbeefdeadbeef"' })
  assert.equal(stale.status, 200)
  } finally { setWebviewDirForTest(pathSync.join(__dirname, 'webview')); fsSync.rmSync(dir, { recursive: true, force: true }) }
})

test('serveStatic: a missing asset is still 404', async () => {
  assert.equal((await getRaw('/nope.js')).status, 404)
})
