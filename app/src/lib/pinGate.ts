// Asks for the parent PIN on screen when a step needs it (see needsPin in profiles.ts).

import { parentPin } from './profiles.ts';

type Request = { reason: string; resolve: (ok: boolean) => void };
let pending: Request | null = null;
const listeners = new Set<() => void>();

export function onPinRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const pinRequest = () => pending;

/** Resolves true when the right PIN is entered (or no PIN is set), false if cancelled. */
export function requestPin(reason: string): Promise<boolean> {
  if (!parentPin()) return Promise.resolve(true);
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { reason, resolve };
    listeners.forEach((fn) => fn());
  });
}

export function answerPin(entered: string | null): boolean {
  if (!pending) return false;
  if (entered !== null && entered !== parentPin()) return false;
  const p = pending;
  pending = null;
  p.resolve(entered !== null);
  listeners.forEach((fn) => fn());
  return true;
}
