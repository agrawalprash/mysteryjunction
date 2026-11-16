import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addConceptSignal, conceptAffinity, features, initialWeights, predict, sampleRate, update } from './learn.ts';
import { canMakeSet, matchPool, needsRefill, poolHealth, trimPool } from './pool.ts';
import type { Candidate } from './types.ts';
import type { FeedContext } from './feed.ts';

const NOW = Date.UTC(2026, 10, 16);
let n = 0;
function cand(over: Partial<Candidate> = {}): Candidate {
  n++;
  return {
    id: `v${n}`, title: `Video ${n}`, channelId: `ch${n}`, channelTitle: 'C', publishedAt: '2022-01-01T00:00:00Z',
    durationSec: 900, views: 40_000, likes: 1600, comments: 80, thumb: '', topic: 't', tier: 'core', because: '', query: '', fetchedAt: NOW,
    ...over,
  };
}
const ctx = (over: Partial<FeedContext> = {}): FeedContext => ({
  profile: {}, now: NOW, shownCounts: {}, watchedIds: new Set(), mutedChannels: new Set(), history: [], ...over,
});
const facets = (concepts: string[]) => ({ subject: 's', format: 'documentary' as const, pace: 'calm' as const, depth: 'deep' as const, clickbait: false, concepts });

test('concept taste: watching maritime videos makes other maritime videos match, not cooking', () => {
  let p = {};
  for (let i = 0; i < 3; i++) p = addConceptSignal(p, ['maritime history', 'age of sail', 'ships'], 1, NOW);
  assert.ok(conceptAffinity(p, ['ships', 'navigation'], NOW) > 0.3);
  assert.equal(conceptAffinity(p, ['baking', 'bread'], NOW), 0);
});

test('ranking model learns: finishing calm deep documentaries raises them over energetic vlogs', () => {
  let w = initialWeights();
  const doc = cand({ facets: facets([]) });
  const vlog = cand({ facets: { ...facets([]), format: 'vlog', pace: 'energetic', depth: 'light' } });
  const before = predict(w, features(doc, 0, NOW)) - predict(w, features(vlog, 0, NOW));
  for (let i = 0; i < 40; i++) {
    w = update(w, features(doc, 0, NOW), 1);
    w = update(w, features(vlog, 0, NOW), 0);
  }
  const after = predict(w, features(doc, 0, NOW)) - predict(w, features(vlog, 0, NOW));
  assert.ok(after > before + 0.3, `gap ${before.toFixed(2)} -> ${after.toFixed(2)}`);
});

test('exploration: a topic that keeps landing is sampled higher than one that keeps missing', () => {
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const avg = (wins: number, tries: number) => Array.from({ length: 300 }, () => sampleRate(wins, tries, rng)).reduce((a, b) => a + b) / 300;
  assert.ok(avg(8, 10) > 0.65);
  assert.ok(avg(0, 10) < 0.2);
  assert.ok(Math.abs(avg(0, 0) - 0.5) < 0.1, 'untried topics stay uncertain, around 50%');
  // A constant random source must not hang.
  assert.ok(sampleRate(3, 5, () => 0.5) > 0);
});

test('pool keeps a fixed size, dropping watched, muted and shown-a-lot videos first', () => {
  const pool = Array.from({ length: 50 }, () => cand());
  const watched = pool[0].id;
  const shown = Object.fromEntries(pool.slice(1, 11).map((c) => [c.id, 4]));
  const trimmed = trimPool(pool, ctx({ watchedIds: new Set([watched]), shownCounts: shown }), 30);
  assert.equal(trimmed.length, 30);
  assert.ok(!trimmed.some((c) => c.id === watched));
  assert.equal(trimmed.filter((c) => shown[c.id]).length, 0);
});

test('pool health decides instant sets and refills; matching finds by words and concepts', () => {
  const pool = [
    ...Array.from({ length: 40 }, () => cand({ tier: 'core' })),
    ...Array.from({ length: 5 }, () => cand({ tier: 'wildcard', title: 'Live afrobeat session', facets: facets(['live music', 'west africa']) })),
  ];
  const h = poolHealth(pool, ctx());
  assert.equal(h.freshMain, 45);
  assert.ok(canMakeSet(h));
  assert.ok(needsRefill(h), 'few wildcards and shorts -> refill');
  assert.equal(matchPool(pool, ctx(), 'something with live music', ['west africa']).length, 5);
});
