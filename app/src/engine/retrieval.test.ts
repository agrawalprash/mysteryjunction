import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lexicalFirst, pickForPage, titleMentions, topicWords } from './retrieval.ts';
import { matchPool } from './pool.ts';
import type { Candidate } from './types.ts';
import type { FeedContext } from './feed.ts';

test('topicWords keeps meaningful words and drops filler', () => {
  assert.deepEqual(topicWords(['The Pyramids and the Nile', 'roman engineering']).sort(), ['engineering', 'nile', 'pyramids', 'roman']);
});

test('titleMentions looks at the title only', () => {
  assert.ok(titleMentions('How Roman AQUEDUCTS carried water', ['aqueducts']));
  assert.ok(!titleMentions('My day in Paris', ['aqueducts']));
});

test('lexicalFirst puts on-topic titles first, then fills at random', () => {
  const items = [{ title: 'vlog' }, { title: 'Minecraft castle build' }, { title: 'cooking' }, { title: 'minecraft redstone' }];
  const out = lexicalFirst(items, ['minecraft'], 3, () => 0.5);
  assert.equal(out.length, 3);
  assert.ok(out.slice(0, 2).every((x) => x.title.toLowerCase().includes('minecraft')));
});

test('pickForPage shows clear matches, and partial ones only when a page would look empty', () => {
  assert.deepEqual(pickForPage([1, 2, 3, 4, 5, 6, 7], [8, 9]), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pickForPage([1, 2], [8, 9]), [1, 2, 8, 9]);
});

test('matchPool no longer matches on filler words like "the" and "and"', () => {
  const NOW = Date.UTC(2026, 10, 17);
  const v = (id: string, title: string): Candidate => ({
    id, title, channelId: id, channelTitle: 'C', publishedAt: '2022-01-01T00:00:00Z', durationSec: 600, views: 1000, likes: 50, comments: 1,
    thumb: '', topic: 't', tier: 'core', because: '', query: '', fetchedAt: NOW,
  });
  const ctx: FeedContext = { profile: {}, now: NOW, shownCounts: {}, watchedIds: new Set(), mutedChannels: new Set(), history: [] };
  const out = matchPool([v('a', 'The best of the cooking show'), v('b', 'Pyramids of Giza explained')], ctx, 'The Pyramids and the Nile');
  assert.deepEqual(out.map((x) => x.id), ['b']);
});

test('quality: a well-liked 2M-view video beats a 10K-view one with a slightly better like ratio', async () => {
  const { quality } = await import('./feed.ts');
  const v = (views: number, likes: number) => ({ id: 'x', title: '', channelId: '', channelTitle: '', publishedAt: '', durationSec: 600, views, likes, comments: views * 0.001, thumb: '' });
  assert.ok(quality(v(2_000_000, 70_000)) > quality(v(10_000, 500)));
  // ...but a badly received popular video doesn't automatically win.
  assert.ok(quality(v(2_000_000, 4_000)) < quality(v(200_000, 9_000)));
});
