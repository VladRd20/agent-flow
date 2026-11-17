import * as fs from 'fs'
import * as path from 'path'

/** process.kill(pid, 0): ESRCH = dead, EPERM = alive (exists, not ours). Anything else: assume alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Deletes stale `<hash>-<pid>.json` discovery files whose recorded pid is dead.
 * Keeps workspaces.json, the caller's own file, unreadable/odd files, and anything
 * that is not a .json file. Returns the removed file names.
 */
export function pruneStaleDiscoveryFiles(
  dir: string,
  ownFile: string | null,
  alive: (pid: number) => boolean = isPidAlive,
): string[] {
  const removed: string[] = []
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return removed }
  const own = ownFile ? path.resolve(ownFile) : null
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'workspaces.json') continue
    const full = path.join(dir, name)
    if (own && path.resolve(full) === own) continue
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8')) as { pid?: unknown }
      if (typeof data.pid !== 'number' || !Number.isInteger(data.pid) || data.pid <= 0) continue
      if (alive(data.pid)) continue
      fs.unlinkSync(full)
      removed.push(name)
    } catch { /* unreadable or already gone: leave it */ }
  }
  return removed
}
