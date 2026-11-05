/**
 * Request checks for Agent Flow's loopback HTTP servers: the hook server, the
 * standalone app server and the dev relay.
 *
 * Kept free of `vscode` so scripts/ and app/ can share it.
 *
 * Binding to 127.0.0.1 keeps other machines out, but not web pages open in the
 * user's browser: a page can POST to a loopback port without a CORS preflight,
 * and DNS rebinding lets a page on an attacker's domain read responses from one.
 */

import type { IncomingHttpHeaders } from 'http'

const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i

/**
 * True if `host` (the request's Host header) is a loopback name.
 *
 * A DNS-rebinding request reaches 127.0.0.1 but still carries the attacker's
 * hostname in Host, so rejecting anything else closes that hole. The port is
 * not checked: it adds nothing against rebinding, and an SSH tunnel such as
 * `-L 8080:127.0.0.1:3001` legitimately arrives as `localhost:8080`.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  return typeof host === 'string' && LOOPBACK_HOST_RE.test(host)
}

const IPV4_HOST_RE = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/
const IPV6_HOST_RE = /^\[[0-9a-f:.]+\](?::\d+)?$/i

/**
 * Host check for a server deliberately bound beyond loopback (the standalone
 * app with `--host 0.0.0.0`), where it is reached by LAN/WAN IP.
 *
 * DNS rebinding only works through a hostname the attacker controls, so an IP
 * literal in Host is safe to accept; any other name must be loopback or listed
 * in `extraHosts` (from AGENT_FLOW_ALLOWED_HOSTS, case-insensitive, no port).
 */
export function isAllowedRemoteHost(host: string | undefined, extraHosts: readonly string[] = []): boolean {
  if (typeof host !== 'string') { return false }
  if (isLoopbackHost(host) || IPV4_HOST_RE.test(host) || IPV6_HOST_RE.test(host)) { return true }
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return extraHosts.some(h => h.trim().toLowerCase() === name)
}

/**
 * True if a request to the hook server can have come from hook.js (or a legacy
 * Claude Code HTTP hook), not from a web page.
 *
 * Both post with a Node HTTP client, which never sends Origin. Browsers send
 * Origin on every POST, same-origin or not, so its presence means a page made
 * the request.
 */
export function isAllowedHookRequest(headers: IncomingHttpHeaders): boolean {
  if (headers.origin !== undefined) { return false }
  return isLoopbackHost(headers.host)
}
