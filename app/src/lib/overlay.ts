// Lets an open panel (like Ask Wander) claim the Back button before screens do.

let closer: (() => void) | null = null;

export function setOverlayCloser(fn: (() => void) | null) {
  closer = fn;
}

/** Returns true if an open panel was closed. */
export function closeOverlay(): boolean {
  if (!closer) return false;
  const fn = closer;
  closer = null;
  fn();
  return true;
}
