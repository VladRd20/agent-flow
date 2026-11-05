import * as fs from 'fs'

/**
 * Read a chunk of bytes from a file at a given offset.
 * Uses try/finally to guarantee the file descriptor is always closed.
 */
export function readFileChunk(filePath: string, offset: number, length: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    // readSync may return fewer bytes than requested (file shrank mid-read);
    // decoding the zero-filled remainder would inject NUL characters.
    const bytesRead = fs.readSync(fd, buffer, 0, length, offset)
    return buffer.toString('utf-8', 0, bytesRead)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Yield the lines of the first `size` bytes of a file, reading in bounded
 * chunks (default 4 MiB) instead of materializing the whole file as one string.
 * Chunks are cut at newline bytes, so multi-byte UTF-8 sequences are never split.
 */
export function* iterateFileLines(filePath: string, size: number, chunkBytes = 4 * 1024 * 1024): Generator<string> {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(chunkBytes)
    let pos = 0
    let carry: Buffer = Buffer.alloc(0)
    while (pos < size) {
      const want = Math.min(chunkBytes, size - pos)
      const n = fs.readSync(fd, buf, 0, want, pos)
      if (n <= 0) break
      pos += n
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n))
      const lastNl = data.lastIndexOf(0x0a)
      if (lastNl === -1) { carry = data; continue }
      carry = Buffer.from(data.subarray(lastNl + 1))
      for (const line of data.toString('utf-8', 0, lastNl).split(/\n/)) yield line.endsWith('\r') ? line.slice(0, -1) : line
    }
    if (carry.length) { const tail = carry.toString('utf-8'); yield tail.endsWith('\r') ? tail.slice(0, -1) : tail }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Async twin of iterateFileLines: same line semantics (first `size` bytes,
 * chunks cut at newline bytes, CR stripped) but reads with fs.promises so the
 * event loop keeps turning between chunks.
 */
export async function* iterateFileLinesAsync(filePath: string, size: number, chunkBytes = 1024 * 1024): AsyncGenerator<string> {
  const fh = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(chunkBytes)
    let pos = 0
    let carry: Buffer = Buffer.alloc(0)
    while (pos < size) {
      const want = Math.min(chunkBytes, size - pos)
      const { bytesRead: n } = await fh.read(buf, 0, want, pos)
      if (n <= 0) break
      pos += n
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n))
      const lastNl = data.lastIndexOf(0x0a)
      if (lastNl === -1) { carry = data; continue }
      carry = Buffer.from(data.subarray(lastNl + 1))
      for (const line of data.toString('utf-8', 0, lastNl).split(/\n/)) yield line.endsWith('\r') ? line.slice(0, -1) : line
    }
    if (carry.length) { const tail = carry.toString('utf-8'); yield tail.endsWith('\r') ? tail.slice(0, -1) : tail }
  } finally {
    await fh.close()
  }
}

/**
 * Read new lines appended to a file since `lastSize` bytes.
 * Returns the new lines, updated file size, and any trailing partial line
 * (bytes past the last newline) as `tail` — pass it back on the next call as
 * `lastTail` to reassemble lines split across reads. If callers ignore `tail`,
 * they silently lose any line that wasn't fully flushed by the writer yet.
 * Handles truncation (file shrunk) by resetting to 0.
 */
export function readNewFileLines(
  filePath: string,
  lastSize: number,
  lastTail = '',
): { lines: string[]; newSize: number; tail: string } | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch { return null /* expected if file was removed */ }

  if (stat.size < lastSize) {
    // File was truncated — reset both size and tail
    return { lines: [], newSize: 0, tail: '' }
  }
  if (stat.size <= lastSize) {
    return null
  }

  const newContent = lastTail + readFileChunk(filePath, lastSize, stat.size - lastSize)
  const parts = newContent.split(/\r?\n/)
  // Last fragment is whatever follows the final newline — empty if the file
  // ended on a newline, otherwise a partial line we need to carry forward.
  const tail = parts.pop() ?? ''
  const lines = parts.filter(Boolean)
  return { lines, newSize: stat.size, tail }
}

/** Case-fold a path string for comparison on Windows, where the filesystem is
 *  case-insensitive and tools disagree on drive-letter case (VS Code reports
 *  `c:\...`, Claude Code and most shells report `C:\...`). Identity elsewhere. */
export function foldPathCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}
