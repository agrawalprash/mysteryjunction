import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleFeed, rowSizes, type FeedContext } from './feed.ts';
import { addConceptSignal } from './learn.ts';
import { addSignal } from './profile.ts';
import type { Candidate } from './types.ts';

const NOW = Date.UTC(2026, 10, 16);
let n = 0;
function vid(tier: Candidate['tier'], concepts: string[]): Candidate {
  n++;
  return {
    id: `v${n}`, title: `Video ${n}`, channelId: `UCch${n}`, channelTitle: `C${n}`, publishedAt: '2022-01-01T00:00:00Z',
    durationSec: 900, views: 40_000, likes: 1600, comments: 80, thumb: '', topic: `t${n % 20}`, tier, because: '', query: '', fetchedAt: NOW,
    facets: { subject: 's', format: (['documentary', 'lecture', 'process', 'explainer', 'travel', 'tutorial'] as const)[n % 6], pace: 'calm', depth: 'deep', clickbait: false, concepts },
  };
}

test('the familiar share grows the familiar rows and shrinks the varied ones', () => {
  const lo = rowSizes(0.2);
  const hi = rowSizes(0.6);
  assert.ok(hi.love + hi.channels > lo.love + lo.channels);
  assert.ok(hi.wildcard <= lo.wildcard && hi.adjacent <= lo.adjacent);
});

test('Home gets "More of what you love" and "From channels you like" for a profile with history', () => {
  let conceptProfile = {};
  for (let i = 0; i < 4; i++) conceptProfile = addConceptSignal(conceptProfile, ['woodworking'], 1, NOW);
  const profile = addSignal({}, 'woodworking', 1.5, NOW, 'core');
  const pool = [
    ...Array.from({ length: 20 }, () => vid('wildcard', ['woodworking', 'craft'])),
    ...Array.from({ length: 20 }, () => vid('adjacent', ['astronomy'])),
    ...Array.from({ length: 8 }, () => vid('channel', ['cooking'])),
  ];
  const ctx: FeedContext = { profile, conceptProfile, now: NOW, shownCounts: {}, watchedIds: new Set(), mutedChannels: new Set(), history: [], rng: () => 0.5 };
  const feed = assembleFeed(pool, ctx, '2026-11-16', { familiar: 0.6 });
  const love = feed.rows.find((r) => r.id === 'love');
  const chans = feed.rows.find((r) => r.id === 'channels');
  assert.ok(love && love.items.length >= 5, 'love row');
  assert.ok(love.items.every((v) => v.facets?.concepts?.includes('woodworking')));
  assert.ok(chans && chans.items.every((v) => v.tier === 'channel'), 'channels row');
});
