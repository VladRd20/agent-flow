/**
 * Combined HTTP server: serves the visualizer UI and streams events via SSE.
 * Reuses the extension's hook server, transcript parser, and session watcher.
 */
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { exec, execFile } from 'child_process'

import { createRelay } from '../../scripts/relay'
import { createTelemetryClient } from '../../scripts/telemetry'
import { serveStatic } from './static'
import { isLoopbackHost, isAllowedRemoteHost } from '../../extension/src/request-guard'
import { createAuthGate, isValidPasswordHash } from './auth'

interface ServerOptions {
  port: number
  host: string
  openBrowser: boolean
  workspace: string
  verbose?: boolean
}

export async function startServer(options: ServerOptions) {
  const { port, host, openBrowser, workspace } = options

  const configDir = path.join(os.homedir(), '.agent-flow')
  const telemetry = createTelemetryClient({
    logDir: path.join(configDir, 'telemetry'),
    installIdPath: path.join(configDir, 'installation-id'),
  })
  await telemetry.init()

  const relay = await createRelay({ workspace, verbose: options.verbose, telemetry })

  const loopbackBind = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  const extraHosts = (process.env.AGENT_FLOW_ALLOWED_HOSTS || '').split(',').filter(Boolean)

  // Optional password gate (see auth.ts). A set-but-malformed hash fails closed
  // rather than silently serving without auth.
  const passwordHash = (process.env.AGENT_FLOW_PASSWORD_HASH || '').trim()
  if (passwordHash && !isValidPasswordHash(passwordHash)) {
    console.error('AGENT_FLOW_PASSWORD_HASH is set but malformed - refusing to start. Regenerate it with --hash-password.')
    process.exit(1)
  }
  const authGate = passwordHash ? createAuthGate(passwordHash) : null

  const server = http.createServer((req, res) => {
    // Reject DNS-rebinding requests, which reach the server under a foreign
    // Host. Loopback binds accept loopback names only; a LAN/WAN bind also
    // accepts IP literals and AGENT_FLOW_ALLOWED_HOSTS names.
    const hostOk = loopbackBind
      ? isLoopbackHost(req.headers.host)
      : isAllowedRemoteHost(req.headers.host, extraHosts)
    if (!hostOk) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }

    const pathname = (req.url || '/').split(/[?#]/, 1)[0]

    if (authGate && authGate.handle(req, res, pathname)) return

    const isRead = req.method === 'GET' || req.method === 'HEAD'

    if (!isRead) {
      // The server is read-only; there are no write endpoints.
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end('Method not allowed')
      return
    }

    // SSE endpoint (query strings tolerated)
    if (pathname === '/events') {
      return relay.handleSSE(req, res)
    }

    // Static files (UI)
    return serveStatic(req, res)
  })

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    else socket.destroy()
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES' || err.code === 'EADDRNOTAVAIL') {
      console.error(`Cannot listen on ${host}:${port} (${err.code}): ${err.message}`)
      relay.dispose()
      void telemetry.dispose().finally(() => process.exit(1))
    } else {
      console.error('Server error:', err)
    }
  })

  server.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
    const exposure = host === '0.0.0.0'
      ? (authGate ? ' (also reachable on your LAN - password required for non-local clients)' : ' (also reachable on your LAN - no auth is enforced)')
      : (authGate ? ' (password required for proxied clients)' : '')
    console.log(`Server running at ${url}${exposure}`)
    console.log('Waiting for agent events...\n')

    if (openBrowser) {
      openURL(url)
    }
  })

  // Cleanup on exit. Idempotent — repeat signals (Ctrl+C spam, SIGTERM+SIGHUP,
  // etc.) would otherwise emit duplicate session_end events and race the
  // telemetry sync loop against itself.
  let shuttingDown = false
  function cleanup() {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    relay.dispose()
    void telemetry.dispose().finally(() => process.exit(0))
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  // SIGHUP fires when the controlling terminal closes (SSH session drops, tmux
  // pane killed). Without a handler, Node's default behavior is to terminate
  // without running cleanup — so session_end never flushes.
  process.on('SIGHUP', cleanup)
}

function openURL(url: string) {
  if (process.platform === 'win32') {
    // 'start' is a shell builtin on Windows — must use exec, not execFile
    exec(`start "" "${url}"`)
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(cmd, [url], () => {})
  }
}
