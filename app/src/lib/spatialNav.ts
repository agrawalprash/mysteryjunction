// Remote-control navigation for TV mode: arrow keys move focus to the nearest
// focusable element in that direction, and OK (Enter) activates it.
// Elements marked data-own-keys handle Left/Right/Enter themselves (the player).

const FOCUSABLE = 'button:not([disabled]), a[href], input, select, summary, [tabindex]:not([tabindex="-1"])';
type Dir = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

function isVisible(el: HTMLElement): boolean {
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && el.offsetParent !== null;
}

function candidates(): HTMLElement[] {
  // While a panel is open, keep focus inside it.
  const scope: ParentNode = document.querySelector('[role="dialog"]') ?? document;
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isVisible);
}

/** Score how good `r` is as the next stop from `c` going `dir` (lower is better). */
export function directionalScore(c: DOMRect, r: DOMRect, dir: Dir): number | null {
  const slack = 8;
  // Sideways distance: 0 when the two boxes overlap on the other axis, plus a little
  // centre-to-centre distance to break ties.
  const gapX = Math.max(0, r.left - c.right, c.left - r.right) + Math.abs(r.left + r.width / 2 - (c.left + c.width / 2)) * 0.1;
  const gapY = Math.max(0, r.top - c.bottom, c.top - r.bottom) + Math.abs(r.top + r.height / 2 - (c.top + c.height / 2)) * 0.1;
  switch (dir) {
    case 'ArrowRight':
      if (r.left < c.right - slack) return null;
      return r.left - c.right + gapY * 3;
    case 'ArrowLeft':
      if (r.right > c.left + slack) return null;
      return c.left - r.right + gapY * 3;
    case 'ArrowDown':
      if (r.top < c.bottom - slack) return null;
      return r.top - c.bottom + gapX * 0.5;
    case 'ArrowUp':
      if (r.bottom > c.top + slack) return null;
      return c.top - r.bottom + gapX * 0.5;
  }
}

function move(dir: Dir): boolean {
  const current = document.activeElement as HTMLElement | null;
  const all = candidates();
  if (!current || current === document.body || !all.includes(current)) {
    focusFirst();
    return true;
  }
  const c = current.getBoundingClientRect();
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === current) continue;
    const s = directionalScore(c, el.getBoundingClientRect(), dir);
    if (s !== null && s < bestScore) {
      best = el;
      bestScore = s;
    }
  }
  if (!best) {
    // Nothing further up: bring the page back to the top so the header is visible.
    if (dir === 'ArrowUp') window.scrollTo({ top: 0, behavior: 'smooth' });
    return false;
  }
  best.focus({ preventScroll: true });
  best.scrollIntoView({
    behavior: 'smooth',
    block: dir === 'ArrowUp' || dir === 'ArrowDown' ? 'center' : 'nearest',
    inline: 'center',
  });
  return true;
}

/** Focus the first sensible element on screen (used when a screen opens). */
export function focusFirst(selector = '[data-autofocus]') {
  const scope: ParentNode = document.querySelector('[role="dialog"]') ?? document;
  const preferred = scope.querySelector<HTMLElement>(selector);
  const target = preferred && isVisible(preferred) ? preferred : candidates().find((el) => el.getBoundingClientRect().top >= 0);
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

let installed = false;

export function enableSpatialNav() {
  if (installed) return;
  installed = true;
  document.addEventListener(
    'keydown',
    (e) => {
      const key = e.key as Dir;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      // Let text fields move their cursor left and right.
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && (key === 'ArrowLeft' || key === 'ArrowRight')) return;
      if (active?.closest('[data-own-keys]') && (key === 'ArrowLeft' || key === 'ArrowRight')) return;
      e.preventDefault();
      move(key);
    },
    true,
  );
}
