/**
 * Static file server for the pre-built webview assets.
 * Serves index.html, index.js, and index.css from app/dist/webview/.
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'

const WEBVIEW_DIR = path.join(__dirname, 'webview')

const HTML_SHELL = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Flow</title>
  <link rel="stylesheet" href="/index.css">
  <style>html, body { height: 100%; margin: 0; padding: 0; }</style>
</head>
<body class="font-sans antialiased" style="background: #0a0a1a;">
  <div id="root" style="height: 100%;"></div>
  <script src="/index.js"></script>
</body>
</html>`

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
}

/** Strip query/fragment and percent-decode; returns null for malformed or NUL-containing paths. */
export function resolveRequestPath(rawUrl: string): string | null {
  const pathname = rawUrl.split(/[?#]/, 1)[0] || '/'
  try {
    const decoded = decodeURIComponent(pathname)
    return decoded.includes('\0') ? null : decoded
  } catch {
    return null
  }
}

const COMMON_HEADERS = { 'X-Content-Type-Options': 'nosniff' }

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = resolveRequestPath(req.url || '/')
  if (url === null) {
    res.writeHead(400, COMMON_HEADERS)
    res.end('Bad request')
    return
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML_SHELL)
    return
  }

  // Only serve known asset files from the webview directory. Backslash is a
  // separator on Windows but not for posix basename, so normalise it first.
  const basename = path.basename(url.replace(/\\/g, '/'))
  const ext = path.extname(basename)
  const mime = MIME_TYPES[ext]

  if (!mime) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const filePath = path.join(WEBVIEW_DIR, basename)

  // Prevent path traversal (belt and braces: basename already strips directories)
  if (!filePath.startsWith(WEBVIEW_DIR + path.sep)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const content = fs.readFileSync(filePath)
    res.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': mime })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}
