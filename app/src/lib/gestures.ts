// Touch-pad gestures for the phone remote:
//   swipe   -> arrow steps (one per STEP px of travel along the dominant axis, like a touchpad)
//   tap     -> OK
//   hold    -> start voice (after HOLD_MS without moving); release -> stop and send

export type Dir = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/** While holding: where the finger has slid. Down = ask Claude; anywhere else = search. */
export type HoldZone = 'auto' | 'ask' | 'search';

export interface GestureHandlers {
  step(dir: Dir): void;
  tap(): void;
  holdStart(): void;
  holdZone?(zone: HoldZone): void;
  holdEnd(zone: HoldZone): void;
}

export const ZONE_PX = 70;

export const STEP_PX = 56;
export const MOVE_SLOP_PX = 14;
export const HOLD_MS = 350;

// Wrapped, because browsers refuse setTimeout/clearTimeout called off `window` ("Illegal invocation").
const defaultTimers = {
  set: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as unknown as typeof setTimeout,
  clear: ((t: ReturnType<typeof setTimeout>) => clearTimeout(t)) as unknown as typeof clearTimeout,
};

export function createGestures(h: GestureHandlers, timers = defaultTimers) {
  let startX = 0;
  let startY = 0;
  let emitted = 0;
  let axis: 'x' | 'y' | null = null;
  let moved = false;
  let holding = false;
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let zone: HoldZone = 'auto';

  return {
    down(x: number, y: number) {
      active = true;
      startX = x;
      startY = y;
      emitted = 0;
      axis = null;
      moved = false;
      holding = false;
      zone = 'auto';
      timer = timers.set(() => {
        if (active && !moved) {
          holding = true;
          h.holdStart();
        }
      }, HOLD_MS);
    },
    move(x: number, y: number) {
      if (!active) return;
      const dx = x - startX;
      const dy = y - startY;
      if (holding) {
        // Sliding while talking picks where it goes.
        const z: HoldZone = dy > ZONE_PX ? 'ask' : 'auto';
        if (z !== zone) {
          zone = z;
          h.holdZone?.(z);
        }
        return;
      }
      if (!moved && Math.hypot(dx, dy) > MOVE_SLOP_PX) {
        moved = true;
        timers.clear(timer);
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (!moved || !axis) return;
      const d = axis === 'x' ? dx : dy;
      const steps = Math.floor(Math.abs(d) / STEP_PX) + 1; // the first step happens as soon as it's a swipe
      while (emitted < steps) {
        emitted++;
        h.step(axis === 'x' ? (d > 0 ? 'ArrowRight' : 'ArrowLeft') : d > 0 ? 'ArrowDown' : 'ArrowUp');
      }
    },
    up() {
      if (!active) return;
      active = false;
      timers.clear(timer);
      if (holding) h.holdEnd(zone);
      else if (!moved) h.tap();
    },
    cancel() {
      active = false;
      timers.clear(timer);
      if (holding) h.holdEnd(zone);
    },
  };
}
