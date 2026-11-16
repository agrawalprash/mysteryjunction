import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGestures, STEP_PX } from './gestures.ts';

function setup() {
  const log: string[] = [];
  let pending: (() => void) | null = null;
  const g = createGestures(
    { step: (d) => log.push(d), tap: () => log.push('tap'), holdStart: () => log.push('holdStart'), holdEnd: () => log.push('holdEnd') },
    { set: ((fn: () => void) => ((pending = fn), 1)) as unknown as typeof setTimeout, clear: (() => (pending = null)) as unknown as typeof clearTimeout },
  );
  return { g, log, fireTimer: () => pending?.() };
}

test('tap is OK', () => {
  const { g, log } = setup();
  g.down(100, 100);
  g.up();
  assert.deepEqual(log, ['tap']);
});

test('swiping up moves up, and a longer swipe moves more steps', () => {
  const { g, log } = setup();
  g.down(100, 400);
  g.move(102, 380);
  g.move(103, 400 - STEP_PX * 2 - 5);
  g.up();
  assert.deepEqual(log, ['ArrowUp', 'ArrowUp', 'ArrowUp']);
});

test('a sideways swipe picks the dominant direction', () => {
  const { g, log } = setup();
  g.down(100, 100);
  g.move(160, 110);
  g.up();
  assert.deepEqual(log, ['ArrowRight', 'ArrowRight']);
});

test('press and hold starts voice; release ends it (no tap, no steps)', () => {
  const { g, log, fireTimer } = setup();
  g.down(100, 100);
  fireTimer();
  g.move(140, 100); // wobble while talking is ignored
  g.up();
  assert.deepEqual(log, ['holdStart', 'holdEnd']);
});

test('moving before the hold delay is a swipe, not voice', () => {
  const { g, log, fireTimer } = setup();
  g.down(100, 100);
  g.move(100, 130);
  fireTimer(); // cleared already; nothing should happen
  g.up();
  assert.deepEqual(log, ['ArrowDown']);
});
