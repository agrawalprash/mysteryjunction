// The candidate pool: a fixed number of videos kept on the device, refilled in the
// background and trimmed by value, so sets can be made instantly with no API calls.

import type { Candidate } from './types.ts';
import { eligible, quality, type FeedContext } from './feed.ts';

export const POOL_SIZE = 1200;
const DAY = 86_400_000;

/** How worth keeping a video is: quality, fading with age and with each time it was shown. */
export function keepValue(c: Candidate, ctx: FeedContext): number {
  if (!eligible(c, ctx, c.tier === 'shorts')) return -1;
  const ageDays = (ctx.now - (c.fetchedAt || ctx.now)) / DAY;
  const shown = ctx.shownCounts[c.id] ?? 0;
  return quality(c) * Math.pow(0.5, shown) * Math.pow(0.5, ageDays / 14) * (c.facets ? 1.15 : 1);
}

/** Keep the best `size` videos; returns the trimmed pool. */
export function trimPool(pool: Candidate[], ctx: FeedContext, size = POOL_SIZE): Candidate[] {
  const keep = pool.map((c) => ({ c, v: keepValue(c, ctx) })).filter((x) => x.v > 0);
  if (keep.length <= size) return keep.map((x) => x.c);
  return keep
    .sort((a, b) => b.v - a.v)
    .slice(0, size)
    .map((x) => x.c);
}

export interface PoolHealth {
  total: number;
  /** Eligible videos never shown, per tier. */
  fresh: Record<string, number>;
  freshMain: number;
  freshShorts: number;
  described: number;
}

export function poolHealth(pool: Candidate[], ctx: FeedContext): PoolHealth {
  const fresh: Record<string, number> = {};
  let freshMain = 0;
  let freshShorts = 0;
  let described = 0;
  for (const c of pool) {
    if (c.facets) described++;
    const isShort = c.tier === 'shorts';
    if (!eligible(c, ctx, isShort) || (ctx.shownCounts[c.id] ?? 0) > 0) continue;
    fresh[c.tier] = (fresh[c.tier] ?? 0) + 1;
    if (isShort) freshShorts++;
    else freshMain++;
  }
  return { total: pool.length, fresh, freshMain, freshShorts, described };
}

/** Enough unseen videos to make a full set right now? */
export function canMakeSet(h: PoolHealth): boolean {
  return h.freshMain >= 30;
}

/** Should the background refill run (low on unseen videos overall or in a tier)? */
export function needsRefill(h: PoolHealth): boolean {
  return h.freshMain < 240 || (h.fresh.wildcard ?? 0) < 25 || (h.fresh.adjacent ?? 0) < 25 || h.freshShorts < 15;
}

/** Pool videos matching words or concepts (for instant search and Ask focus). */
export function matchPool(pool: Candidate[], ctx: FeedContext, text: string, concepts: string[] = [], limit = 30): Candidate[] {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  const wanted = new Set(concepts.map((c) => c.toLowerCase()));
  const scored: { c: Candidate; s: number }[] = [];
  for (const c of pool) {
    if (!eligible(c, ctx, c.tier === 'shorts')) continue;
    const hay = `${c.title} ${c.channelTitle} ${c.topic} ${(c.facets?.concepts ?? []).join(' ')} ${c.facets?.subject ?? ''}`.toLowerCase();
    let s = 0;
    for (const w of words) if (hay.includes(w)) s += 1;
    for (const k of c.facets?.concepts ?? []) if (wanted.has(k.toLowerCase())) s += 2;
    if (s > 0) scored.push({ c, s: s * quality(c) });
  }
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}
