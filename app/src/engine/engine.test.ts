import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSignal, coreInterests, freshness, interest, watchSignal, type Profile } from './profile.ts';
import { assembleFeed, eligible, type FeedContext } from './feed.ts';
import type { Candidate, Tier } from './types.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 15);

function seeded(seed = 1) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

let n = 0;
function cand(tier: Tier, topic: string, over: Partial<Candidate> = {}): Candidate {
  n += 1;
  return {
    id: `v${n}`,
    title: `Video ${n}`,
    channelId: `ch${n}`,
    channelTitle: `Channel ${n}`,
    publishedAt: '2021-05-01T00:00:00Z',
    durationSec: 600,
    views: 50_000,
    likes: 2_000,
    comments: 100,
    thumb: '',
    topic,
    tier,
    because: '',
    query: topic,
    fetchedAt: NOW,
    ...over,
  };
}

function ctx(over: Partial<FeedContext> = {}): FeedContext {
  return { profile: {}, now: NOW, shownCounts: {}, watchedIds: new Set(), mutedChannels: new Set(), history: [], rng: seeded(), ...over };
}

test('watch signal rewards finishing and penalises bailing early', () => {
  assert.equal(watchSignal(540, 600), 1);
  assert.equal(watchSignal(240, 600), 0.5);
  assert.equal(watchSignal(10, 600), -0.4);
  assert.ok(watchSignal(60, 600) > 0);
});

test('interest decays: short-term memory fades faster than long-term', () => {
  let p: Profile = {};
  p = addSignal(p, 'Woodworking', 1, NOW);
  const t = p['woodworking'];
  const after = interest(t, NOW + 30 * DAY);
  assert.ok(after < interest(t, NOW));
  assert.ok(after > 0.1, 'long-term memory should keep some interest after a month');
});

test('binge-watching a topic makes it rest (fatigue), then it recovers', () => {
  let p: Profile = {};
  for (let i = 0; i < 5; i++) p = addSignal(p, 'chess', 1, NOW + i * 1000, 'core', { watched: true });
  assert.ok(freshness(p['chess'], NOW + 5000) < 0.5);
  assert.equal(freshness(p['chess'], NOW + 4 * DAY), 1);
});

test('a wildcard that keeps landing graduates into a core interest', () => {
  let p: Profile = {};
  assert.equal(coreInterests(p, NOW).length, 0);
  p = addSignal(p, 'deep sea creatures', 1, NOW, 'wildcard', { watched: true });
  assert.deepEqual(coreInterests(p, NOW).map((t) => t.name), ['deep sea creatures']);
});

test('feed never shows watched, muted or wrong-length videos', () => {
  const watched = cand('core', 'a');
  const muted = cand('core', 'b', { channelId: 'muted' });
  const tooShort = cand('core', 'c', { durationSec: 45 });
  const fine = cand('core', 'd');
  const c = ctx({ watchedIds: new Set([watched.id]), mutedChannels: new Set(['muted']) });
  assert.equal(eligible(watched, c), false);
  assert.equal(eligible(muted, c), false);
  assert.equal(eligible(tooShort, c), false);
  assert.equal(eligible(fine, c), true);
  assert.equal(eligible(tooShort, c, true), true, 'a 45s video is fine as a short');
});

test('feed enforces variety: one video per channel, few per topic', () => {
  const pool: Candidate[] = [];
  for (let i = 0; i < 20; i++) pool.push(cand('core', 'woodworking', { channelId: 'same-channel' }));
  for (let i = 0; i < 20; i++) pool.push(cand('core', `topic-${i % 5}`));
  const feed = assembleFeed(pool, ctx(), '2026-11-15');
  const items = feed.rows.flatMap((r) => r.items);
  const perChannel = new Map<string, number>();
  const perTopic = new Map<string, number>();
  for (const i of items) {
    perChannel.set(i.channelId, (perChannel.get(i.channelId) ?? 0) + 1);
    perTopic.set(i.topic, (perTopic.get(i.topic) ?? 0) + 1);
  }
  assert.ok((perChannel.get('same-channel') ?? 0) <= 2);
  assert.ok(Math.max(...perTopic.values()) <= 4);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'no duplicates');
});

test('already-shown videos lose to fresh ones of equal quality', () => {
  const shown = Array.from({ length: 8 }, (_, i) => cand('core', `t${i}`));
  const freshOnes = Array.from({ length: 8 }, (_, i) => cand('core', `u${i}`));
  const shownCounts = Object.fromEntries(shown.map((c) => [c.id, 1]));
  const feed = assembleFeed([...shown, ...freshOnes], ctx({ shownCounts }), '2026-11-15');
  const core = feed.rows.find((r) => r.id === 'core')!;
  const freshCount = core.items.filter((i) => freshOnes.some((f) => f.id === i.id)).length;
  assert.ok(freshCount >= 6, `expected mostly fresh videos, got ${freshCount}/8`);
});

test('rows come out in the planned order with labels, and the feed is finite', () => {
  const pool = [
    ...Array.from({ length: 10 }, (_, i) => cand('core', `c${i}`)),
    ...Array.from({ length: 10 }, (_, i) => cand('adjacent', `a${i}`)),
    ...Array.from({ length: 10 }, (_, i) => cand('wildcard', `w${i}`)),
    ...Array.from({ length: 6 }, (_, i) => cand('archive', `old${i}`, { publishedAt: '2010-01-01T00:00:00Z' })),
    ...Array.from({ length: 6 }, (_, i) => cand('core', `g${i}`, { views: 5000, likes: 400 })),
    ...Array.from({ length: 12 }, (_, i) => cand('shorts', `s${i}`, { durationSec: 40 })),
  ];
  const feed = assembleFeed(pool, ctx(), '2026-11-15');
  assert.deepEqual(feed.rows.map((r) => r.id), ['core', 'adjacent', 'wildcard', 'gems', 'archive']);
  const total = feed.rows.reduce((s, r) => s + r.items.length, 0);
  assert.ok(total <= 31);
  assert.ok(feed.shorts.length <= 10 && feed.shorts.length > 0);
});
