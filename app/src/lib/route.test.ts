import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeUtterance } from './route.ts';

test('plain topics are searches', () => {
  for (const s of ['Hans Zimmer live', 'cat compilations', 'how to sharpen a chisel', 'Veritasium', 'F1 Monaco highlights 2026']) {
    assert.equal(routeUtterance(s), 'search', s);
  }
});

test('wishes and instructions go to Claude', () => {
  for (const s of [
    'something calm tonight',
    'show me something funny',
    "I'm in the mood for music",
    'add a row for jazz',
    'remember I love space',
    'less true crime please',
    'no more cooking videos',
    'give me a fresh set',
    'can you find me some long documentaries about the ocean',
  ]) {
    assert.equal(routeUtterance(s), 'ask', s);
  }
});
