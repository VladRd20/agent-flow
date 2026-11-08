/**
 * Static file server for the pre-built webview assets.
 * Serves index.html, index.js, and index.css from app/dist/webview/.
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { FAVICON_LINK_TAGS } from './favicon'

const WEBVIEW_DIR = path.join(__dirname, 'webview')

/**
 * Asset version stamp (content hash of the built bundle) appended to asset URLs, so a
 * CDN/browser copy of an older build is never reused after a deploy. Computed once per
 * process: the watchdog rebuilds before every start, so a restart picks up a new hash.
 */
let assetVersion: string | null = null
function getAssetVersion(): string {
  if (assetVersion !== null) return assetVersion
  try {
    const h = crypto.createHash('sha256')
    for (const f of ['index.js', 'index.css']) {
      try { h.update(fs.readFileSync(path.join(WEBVIEW_DIR, f))) } catch { /* missing asset */ }
    }
    assetVersion = h.digest('hex').slice(0, 12)
  } catch {
    assetVersion = String(Date.now())
  }
  return assetVersion
}

const htmlShell = (v: string) => `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
  <meta name="theme-color" content="#0a0a1a">
  <meta name="color-scheme" content="dark">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Agent Flow</title>
  ${FAVICON_LINK_TAGS}
  <link rel="stylesheet" href="/index.css?v=${v}">
  <style>html, body { height: 100%; margin: 0; padding: 0; background: #0a0a1a; } body { position: fixed; inset: 0; overflow: hidden; }</style>
</head>
<body class="font-sans antialiased" style="background: #0a0a1a;">
  <div id="root" style="height: 100%;"></div>
  <script src="/index.js?v=${v}"></script>
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

// `private` keeps shared caches (Cloudflare's edge in front of the tunnel) from storing
// anything: a cached copy would be served stale and without the password gate.
// `no-cache` makes browsers revalidate, so a deploy shows up on a plain reload.
const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-cache',
  // No strict CSP: the shell relies on an inline <style> and an IIFE bundle. These two
  // headers stop referrer leakage and clickjacking without risking the UI.
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
}

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = resolveRequestPath(req.url || '/')
  if (url === null) {
    res.writeHead(400, COMMON_HEADERS)
    res.end('Bad request')
    return
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
    res.end(htmlShell(getAssetVersion()))
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
