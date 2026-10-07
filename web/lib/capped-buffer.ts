/** Push an item onto an array in place, trimming from the front if it would
 *  exceed `maxSize`. Mutates and returns `buf` for convenience. */
export function pushCapped<T>(buf: T[], item: T, maxSize: number): T[] {
  buf.push(item)
  if (buf.length > maxSize) {
    buf.splice(0, buf.length - maxSize)
  }
  return buf
}
