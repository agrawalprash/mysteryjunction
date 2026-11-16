import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWorlds, worldVideos } from './worlds.ts';
import { addConceptSignal } from './learn.ts';
import type { Candidate } from './types.ts';

const NOW = Date.UTC(2026, 10, 16);
let n = 0;
function vid(concepts: string[]): Candidate {
  n++;
  return {
    id: `v${n}`, title: `Video ${n}`, channelId: `ch${n}`, channelTitle: 'C', publishedAt: '2022-01-01T00:00:00Z',
    durationSec: 600, views: 1000, likes: 50, comments: 5, thumb: '', topic: 't', tier: 'core', because: '', query: '', fetchedAt: NOW,
    facets: { subject: 's', format: 'documentary', pace: 'calm', depth: 'deep', clickbait: false, concepts },
  };
}
const many = (k: number, concepts: string[]) => Array.from({ length: k }, () => vid(concepts));

test('worlds follow what the profile likes, and edges are unexplored neighbours', () => {
  const pool = [
    ...many(4, ['minecraft', 'caves']),
    ...many(3, ['minecraft', 'redstone']),
    ...many(5, ['volcanoes', 'geology']),
    ...many(4, ['cooking']),
  ];
  let p = {};
  for (let i = 0; i < 3; i++) p = addConceptSignal(p, ['minecraft'], 1, NOW);
  const w = computeWorlds(pool, p, NOW);
  assert.deepEqual(w.yours.map((x) => x.concept), ['minecraft']);
  const edges = w.edges.map((x) => x.concept);
  assert.ok(edges.includes('caves') && edges.includes('redstone'), edges.join());
  assert.ok(!edges.includes('cooking') && !edges.includes('volcanoes'), 'unrelated worlds are not edges');
  assert.equal(w.edges[0].via, 'minecraft');
});

test('a new profile sees the biggest worlds in its pool, and switching passions moves the worlds', () => {
  const pool = [...many(6, ['dinosaurs', 'fossils']), ...many(3, ['minecraft'])];
  assert.equal(computeWorlds(pool, {}, NOW).yours[0].concept, 'dinosaurs');
  let p = {};
  for (let i = 0; i < 3; i++) p = addConceptSignal(p, ['dinosaurs'], 1, NOW);
  const w = computeWorlds(pool, p, NOW);
  assert.equal(w.yours[0].concept, 'dinosaurs');
  assert.deepEqual(w.edges.map((x) => x.concept), ['fossils']);
});

test('worldVideos returns only that world, best first', () => {
  const pool = [...many(3, ['space']), ...many(2, ['ships'])];
  const out = worldVideos(pool, 'Space', (c) => Number(c.id.slice(1)));
  assert.equal(out.length, 3);
  assert.ok(Number(out[0].id.slice(1)) > Number(out[2].id.slice(1)));
});

test('nearbyWorlds lists the worlds that share videos, most shared first', async () => {
  const { nearbyWorlds } = await import('./worlds.ts');
  const pool = [...many(3, ['jazz', 'live music']), ...many(1, ['jazz', 'new york']), ...many(3, ['new york'])];
  assert.deepEqual(nearbyWorlds(pool, 'jazz').map((w) => w.concept), ['live music', 'new york']);
});
