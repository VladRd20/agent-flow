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

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split(/[?#]/, 1)[0]
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
    console.log(`Server running at ${url}${host === '0.0.0.0' ? ' (also reachable on your LAN - no auth is enforced)' : ''}`)
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
