import { useEffect, useRef, type RefObject } from 'react'

/**
 * Hook that calls `onClose` when a pointerdown event occurs outside the referenced element.
 * pointerdown (not mousedown) because the canvas preventDefaults touchstart, so iOS never
 * synthesizes mouse events after a touch. A short delay prevents the opening tap from
 * immediately triggering close. The callback is kept in a ref so a new function identity
 * each render does not resubscribe the listener.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  delayMs = 50,
): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const handleDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCloseRef.current()
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', handleDown)
    }, delayMs)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', handleDown)
    }
  }, [ref, delayMs])
}
