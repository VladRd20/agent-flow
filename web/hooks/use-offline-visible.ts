"use client"

import { useEffect, useState } from 'react'
import type { ConnectionStatus } from '@/lib/bridge-types'

/**
 * True once the connection has been 'disconnected' for `delayMs`. The bridge starts out
 * 'disconnected' before the first connect, so a short grace period stops "Offline" from
 * flashing on every page load; it clears immediately when the connection returns.
 */
export function useOfflineVisible(status: ConnectionStatus, delayMs = 1500): boolean {
  const [elapsed, setElapsed] = useState(false)
  const disconnected = status === 'disconnected'
  useEffect(() => {
    if (!disconnected) { setElapsed(false); return }
    const id = setTimeout(() => setElapsed(true), delayMs)
    return () => clearTimeout(id)
  }, [disconnected, delayMs])
  return disconnected && elapsed
}
