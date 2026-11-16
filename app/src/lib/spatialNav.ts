// Remote-control navigation for TV mode: arrow keys move focus to the nearest
// focusable element in that direction, and OK (Enter) activates it.
// Elements marked data-own-keys handle Left/Right/Enter themselves (the player).

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select, summary, [tabindex]:not([tabindex="-1"])';
type Dir = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

function isVisible(el: HTMLElement): boolean {
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && el.offsetParent !== null;
}

function candidates(fromHeader = false): HTMLElement[] {
  // While a panel is open, keep focus inside it.
  const dialog = document.querySelector('[role="dialog"]');
  const scope: ParentNode = dialog ?? document;
  // Things scrolled underneath the sticky header can't be seen, so they aren't stops.
  // (Only matters when moving sideways along the header; rows above are reached by scrolling.)
  const header = !dialog && fromHeader ? document.querySelector<HTMLElement>('.topbar') : null;
  const headerBottom = header && isVisible(header) ? header.getBoundingClientRect().bottom : -Infinity;
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (!isVisible(el)) return false;
    if (header && !header.contains(el)) {
      const r = el.getBoundingClientRect();
      if (r.top + r.height / 2 < headerBottom) return false;
    }
    return true;
  });
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

// ---------------------------------------------------------------- calm scrolling
// One short animation per scroll target; a new key press restarts from wherever the
// page is, instead of queueing animations (which is what makes scrolling jumpy).

const anims = new Map<Element | Window, number>();

function scrollPos(t: Element | Window, axis: 'x' | 'y') {
  if (t === window) return axis === 'y' ? window.scrollY : window.scrollX;
  const el = t as Element;
  return axis === 'y' ? el.scrollTop : el.scrollLeft;
}

function setScroll(t: Element | Window, axis: 'x' | 'y', v: number) {
  if (t === window) window.scrollTo(axis === 'x' ? v : window.scrollX, axis === 'y' ? v : window.scrollY);
  else if (axis === 'y') (t as Element).scrollTop = v;
  else (t as Element).scrollLeft = v;
}

export function animateScrollBy(t: Element | Window, axis: 'x' | 'y', delta: number, ms = 220) {
  if (Math.abs(delta) < 1) return;
  const prev = anims.get(t);
  if (prev) cancelAnimationFrame(prev);
  const from = scrollPos(t, axis);
  const to = from + delta;
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    setScroll(t, axis, from + (to - from) * eased);
    if (p < 1) anims.set(t, requestAnimationFrame(step));
    else anims.delete(t);
  };
  anims.set(t, requestAnimationFrame(step));
}

function headerBottom(): number {
  if (document.querySelector('[role="dialog"]')) return 0;
  const h = document.querySelector<HTMLElement>('.topbar');
  return h && isVisible(h) ? h.getBoundingClientRect().bottom : 0;
}

/** Scroll just enough to show `el` (and its row title, for cards in a row). */
function reveal(el: HTMLElement) {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const gap = 1.5 * rem;
  // Sideways, inside a row of cards.
  const row = el.closest<HTMLElement>('.row-scroll');
  if (row) {
    const r = el.getBoundingClientRect();
    const c = row.getBoundingClientRect();
    const pad = 3 * rem;
    if (r.left < c.left + pad) animateScrollBy(row, 'x', r.left - (c.left + pad));
    else if (r.right > c.right - pad) animateScrollBy(row, 'x', r.right - (c.right - pad));
  }
  // Up and down, inside the open panel or the page.
  const dialog = el.closest<HTMLElement>('.sheet');
  const target: Element | Window = dialog ?? window;
  const area = dialog ? dialog.getBoundingClientRect() : { top: headerBottom(), bottom: window.innerHeight };
  // Rows of cards: the focused row (with its title) sits near the top, like a TV launcher,
  // so the next row is always peeking in below.
  const section = el.closest<HTMLElement>('.row');
  if (section && !dialog) {
    animateScrollBy(target, 'y', section.getBoundingClientRect().top - (area.top + gap * 0.5));
    return;
  }
  const box = el.getBoundingClientRect();
  if (box.top < area.top + gap) animateScrollBy(target, 'y', box.top - (area.top + gap));
  else if (box.bottom > area.bottom - gap) animateScrollBy(target, 'y', box.bottom - (area.bottom - gap));
}

/** True if there's more page (or panel) to scroll to in that direction. */
function canScroll(dir: 'ArrowUp' | 'ArrowDown'): Element | Window | null {
  const dialog = document.querySelector<HTMLElement>('.sheet');
  if (dialog) {
    const more = dir === 'ArrowDown' ? dialog.scrollTop + dialog.clientHeight < dialog.scrollHeight - 2 : dialog.scrollTop > 0;
    return more ? dialog : null;
  }
  const doc = document.documentElement;
  const more = dir === 'ArrowDown' ? window.scrollY + window.innerHeight < doc.scrollHeight - 2 : window.scrollY > 0;
  return more ? window : null;
}

function move(dir: Dir): boolean {
  const current = document.activeElement as HTMLElement | null;
  const inHeader = !!current?.closest('.topbar');
  const all = candidates(inHeader && (dir === 'ArrowLeft' || dir === 'ArrowRight'));
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
  // Long text with nothing to select in it: page through it instead of jumping past.
  if (dir === 'ArrowDown' || dir === 'ArrowUp') {
    const scroller = canScroll(dir);
    const view = window.innerHeight;
    const r = best?.getBoundingClientRect();
    // Only page when the next stop is fully off-screen (text in between would be skipped).
    const inRow = !!best?.closest('.row, .topbar');
    // Also step through when the next stop is on screen but far away: the text in between
    // would otherwise fly past in one jump.
    const gap = r ? (dir === 'ArrowDown' ? r.top - c.bottom : c.top - r.bottom) : Infinity;
    const offscreen =
      !r || (!inRow && (dir === 'ArrowDown' ? r.top > view : r.bottom < headerBottom())) || (!inRow && gap > view * 0.35);
    // From the full-screen player, ▼ goes straight to the buttons below it.
    if (scroller && offscreen && !current.closest('[data-own-keys]')) {
      // About a third of a screen: a few lines at a time, so you can read along.
      animateScrollBy(scroller, 'y', (dir === 'ArrowDown' ? 1 : -1) * view * 0.3);
      // Don't leave focus stuck in the header (or scrolled out of view): once the page has moved,
      // put it on the first thing you can now see in that direction.
      setTimeout(() => settleFocusAfterPaging(current, dir), 260);
      return true;
    }
  }
  if (!best) return false;
  best.focus({ preventScroll: true });
  reveal(best);
  return true;
}

function settleFocusAfterPaging(previous: HTMLElement, dir: 'ArrowUp' | 'ArrowDown') {
  if (document.activeElement !== previous) return; // something else took focus meanwhile
  const top = headerBottom();
  const r = previous.getBoundingClientRect();
  const stillVisible = r.bottom > top && r.top < window.innerHeight;
  if (stillVisible && !previous.closest('.topbar')) return;
  const visible = candidates().filter((el) => {
    if (el.closest('.topbar')) return false;
    const b = el.getBoundingClientRect();
    return b.top >= top && b.bottom <= window.innerHeight;
  });
  visible.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const next = dir === 'ArrowDown' ? visible[0] : visible[visible.length - 1];
  if (next) next.focus({ preventScroll: true });
  else if (previous.closest('.topbar')) previous.blur();
}

/** Focus the first sensible element on screen (used when a screen opens). */
export function focusFirst(selector = '[data-autofocus]') {
  const scope: ParentNode = document.querySelector('[role="dialog"]') ?? document;
  const preferred = scope.querySelector<HTMLElement>(selector);
  const target = preferred && isVisible(preferred) ? preferred : candidates().find((el) => el.getBoundingClientRect().top >= 0);
  target?.focus({ preventScroll: true });
  if (target) reveal(target);
}

let installed = false;

/**
 * On a TV, landing on a text field shouldn't pop up the on-screen keyboard. Fields are
 * read-only while you pass through; pressing OK on one unlocks it and opens the keyboard.
 */
let reopening = false;

function lockTextFields() {
  const isField = (el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit'].includes(el.type));
  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target;
      if (reopening || !document.body.classList.contains('tv') || !isField(el) || el.dataset.tvEditing === '1') return;
      if (!el.readOnly) {
        el.readOnly = true;
        el.dataset.tvLocked = '1';
      }
    },
    true,
  );
  document.addEventListener(
    'focusout',
    (e) => {
      const el = e.target;
      if (reopening || !isField(el)) return;
      if (el.dataset.tvEditing === '1') {
        delete el.dataset.tvEditing;
        el.readOnly = true;
        el.dataset.tvLocked = '1';
      }
    },
    true,
  );
  // A pointer click (mouse plugged into the TV, or a touchscreen) unlocks too.
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target;
      if (!isField(el) || el.dataset.tvLocked !== '1') return;
      el.readOnly = false;
      delete el.dataset.tvLocked;
      el.dataset.tvEditing = '1';
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      const el = document.activeElement;
      if (!document.body.classList.contains('tv') || !isField(el) || el.dataset.tvLocked !== '1' || e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      el.readOnly = false;
      delete el.dataset.tvLocked;
      el.dataset.tvEditing = '1';
      // Re-focus so Android shows the keyboard for the now-editable field.
      reopening = true;
      el.blur();
      el.focus();
      reopening = false;
      el.click();
    },
    true,
  );
}

export function enableSpatialNav() {
  if (installed) return;
  installed = true;
  lockTextFields();
  document.addEventListener(
    'keydown',
    (e) => {
      const key = e.key as Dir;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      // Let a text field you're typing in move its cursor left and right.
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && (active as HTMLElement).dataset.tvEditing === '1' && (key === 'ArrowLeft' || key === 'ArrowRight'))
        return;
      if (active?.closest('[data-own-keys]') && (key === 'ArrowLeft' || key === 'ArrowRight')) return;
      e.preventDefault();
      move(key);
    },
    true,
  );
}
