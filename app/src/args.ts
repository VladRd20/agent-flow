import { DEFAULT_RELAY_PORT, DEFAULT_APP_HOST } from '../../extension/src/constants'

/** Parse CLI arguments. Keeps it simple — no dependencies. */
export function parseArgs(argv: string[]) {
  let port = DEFAULT_RELAY_PORT
  let host = DEFAULT_APP_HOST
  let open = true
  let verbose = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10)
      if (!isNaN(n) && n > 0 && n < 65536) port = n
      i++
    } else if (arg === '--host' && argv[i + 1]) {
      // Host is interpolated into a shell command on Windows (openURL), so only
      // accept plain hostnames / IP literals.
      if (/^[A-Za-z0-9.:_-]+$/.test(argv[i + 1])) host = argv[i + 1]
      else console.error(`Ignoring invalid --host value: ${argv[i + 1]}`)
      i++
    } else if (arg === '--no-open') {
      open = false
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: agent-flow [options]

Options:
  -p, --port <number>  Port for the server (default: ${DEFAULT_RELAY_PORT})
  --host <address>     Address to bind to (default: ${DEFAULT_APP_HOST}). No auth
                        exists on this server - only bind beyond loopback on a
                        trusted network.
  --no-open            Don't open the browser automatically
  -v, --verbose        Show detailed event logs
  -h, --help           Show this help message
`)
      process.exit(0)
    }
  }

  return { port, host, open, verbose }
}
