/**
 * Agent Flow — standalone web app for visualizing AI agent orchestration.
 *
 * Starts a local server that:
 *   1. Receives events from agent hooks
 *   2. Watches JSONL transcript files for active sessions
 *   3. Serves the visualizer UI and streams events via SSE
 *   4. Opens the browser automatically
 *
 * Usage: npx @agent-flow/app [--port <number>] [--no-open]
 */
import { parseArgs } from './args'
import { ensureSetup } from '../../scripts/setup'
import { startServer } from './server'
import { hashPassword } from './auth'

// `--hash-password`: read a password from stdin, print an AGENT_FLOW_PASSWORD_HASH value, exit.
if (process.argv.includes('--hash-password')) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { input += c })
  process.stdin.on('end', () => {
    const pw = input.replace(/\r?\n$/, '')
    if (!pw) { console.error('Empty password.'); process.exit(1) }
    console.log(hashPassword(pw))
    process.exit(0)
  })
} else {
  main()
}

function main() {
const args = parseArgs(process.argv.slice(2))

console.log('Agent Flow (local fork)\n')

// Ensure hooks are configured
ensureSetup()

// Start the server
startServer({
  port: args.port,
  host: args.host,
  openBrowser: args.open,
  workspace: process.cwd(),
  verbose: args.verbose,
})
}
