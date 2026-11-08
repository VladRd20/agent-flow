/**
 * Layered Escape: one key press dismisses only the topmost open layer (search input, menu,
 * sheet, popup, ...); the selection-clearing shortcut is the bottom layer and only runs when
 * nothing above it handled the press. Layers register while enabled, so the most recently
 * opened one is on top.
 */
export interface EscapeStack {
  push(handler: () => void): () => void
  /** Run the topmost handler. Returns true when a layer handled the press. */
  dispatch(event: object): boolean
  wasHandled(event: object): boolean
}

export function createEscapeStack(): EscapeStack {
  const layers: Array<{ run: () => void }> = []
  const handled = new WeakSet<object>()
  return {
    push(handler) {
      const layer = { run: handler }
      layers.push(layer)
      return () => {
        const i = layers.indexOf(layer)
        if (i >= 0) layers.splice(i, 1)
      }
    },
    dispatch(event) {
      const top = layers[layers.length - 1]
      if (!top) return false
      handled.add(event)
      top.run()
      return true
    },
    wasHandled(event) {
      return handled.has(event)
    },
  }
}

export const escapeStack = createEscapeStack()
