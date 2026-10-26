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
