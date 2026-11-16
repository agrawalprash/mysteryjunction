// Turns a pool of candidate videos into today's finite, varied home feed.

import type { Candidate, CustomRow, DailyFeed, FeedRow, Video, WatchRecord } from './types.ts';
import { conceptAffinity, conceptsOf, features, predict, sampleRate, type Weights } from './learn.ts';
import {
  coreInterests,
  facetBoost,
  freshness,
  interest,
  normalizeTopic,
  recentMisses,
  watchAgainCandidates,
  type Profile,
} from './profile.ts';

export const MAIN_MIN_SEC = 120;
export const MAIN_MAX_SEC = 3 * 60 * 60;
export const SHORT_MAX_SEC = 180;

export function likeRatio(v: Video): number {
  return v.views > 0 ? v.likes / v.views : 0;
}

/** Rough "is this worth someone's time" score from public engagement numbers. */
export function quality(v: Video): number {
  const views = Math.max(v.views, 1);
  const lr = v.likes / views; // typical: 0.01–0.06
  const cr = v.comments / views;
  let q = 0.5 + Math.min(lr / 0.04, 1.5) * 0.6 + Math.min(cr / 0.003, 1) * 0.2;
  if (v.views < 300) q *= 0.5; // too unproven to recommend blind
  return q;
}

export function isHiddenGem(v: Video): boolean {
  return v.views >= 1000 && v.views < 100_000 && likeRatio(v) >= 0.035;
}

export function isArchive(v: Video): boolean {
  return new Date(v.publishedAt).getFullYear() < 2016;
}

export interface FeedContext {
  profile: Profile;
  now: number;
  /** videoId -> how many daily feeds it already appeared in */
  shownCounts: Record<string, number>;
  watchedIds: Set<string>;
  mutedChannels: Set<string>;
  history: WatchRecord[];
  /** Learned format/pace/depth leanings (empty if Claude hasn't described any videos yet). */
  facetProfile?: Profile;
  /** Taste over Claude's concept tags. */
  conceptProfile?: Profile;
  /** The on-device ranking model's weights. */
  weights?: Weights;
  rng?: () => number;
}

interface Used {
  ids: Set<string>;
  channels: Map<string, number>;
  topics: Map<string, number>;
  formats: Map<string, number>;
}

function newUsed(): Used {
  return { ids: new Set(), channels: new Map(), topics: new Map(), formats: new Map() };
}

function markUsed(used: Used, c: Candidate) {
  used.ids.add(c.id);
  used.channels.set(c.channelId, (used.channels.get(c.channelId) ?? 0) + 1);
  const t = normalizeTopic(c.topic);
  used.topics.set(t, (used.topics.get(t) ?? 0) + 1);
  if (c.facets) used.formats.set(c.facets.format, (used.formats.get(c.facets.format) ?? 0) + 1);
}

/** At most this many videos of one format (documentary, lecture…) across the whole feed. */
export const FORMAT_CAP = 7;

/**
 * Greedy pick with diversity caps: at most `channelCap` videos per channel and
 * `topicCap` per topic across the whole feed. If a row can't be filled under
 * the strict caps, they're relaxed by one so rows don't come out empty.
 */
function pick(
  pool: Candidate[],
  n: number,
  used: Used,
  score: (c: Candidate) => number,
  caps = { channelCap: 1, topicCap: 3 },
): Candidate[] {
  const ranked = pool
    .filter((c) => !used.ids.has(c.id))
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const out: Candidate[] = [];
  for (const relax of [0, 1]) {
    for (const { c } of ranked) {
      if (out.length >= n) break;
      if (used.ids.has(c.id)) continue;
      if ((used.channels.get(c.channelId) ?? 0) >= caps.channelCap + relax) continue;
      if ((used.topics.get(normalizeTopic(c.topic)) ?? 0) >= caps.topicCap + relax) continue;
      if (c.facets && (used.formats.get(c.facets.format) ?? 0) >= FORMAT_CAP + relax * 3) continue;
      out.push(c);
      markUsed(used, c);
    }
    if (out.length >= n) break;
  }
  return out;
}

/** Filters out things that should never appear: watched, muted, wrong length. */
export function eligible(c: Candidate, ctx: FeedContext, shorts = false): boolean {
  if (ctx.watchedIds.has(c.id)) return false;
  if (ctx.mutedChannels.has(c.channelId)) return false;
  if (shorts) return c.durationSec > 0 && c.durationSec <= SHORT_MAX_SEC;
  return c.durationSec >= MAIN_MIN_SEC && c.durationSec <= MAIN_MAX_SEC;
}

export function makeScorer(ctx: FeedContext) {
  const rng = ctx.rng ?? Math.random;
  const misses = new Set(recentMisses(ctx.profile, ctx.now, 50).map((t) => normalizeTopic(t.name)));
  return (c: Candidate): number => {
    const key = normalizeTopic(c.topic);
    const t = ctx.profile[key];
    let s = quality(c);
    // Already shown on an earlier day: fade fast so the feed keeps moving.
    s *= Math.pow(0.35, ctx.shownCounts[c.id] ?? 0);
    if (t) {
      s *= freshness(t, ctx.now);
      if (c.tier === 'core') s *= 1 + Math.max(0, Math.min(interest(t, ctx.now), 2)) * 0.3;
    }
    if (misses.has(key)) s *= 0.6;
    // Learned format/pace/depth leanings, and a penalty for clickbait.
    s *= facetBoost(ctx.facetProfile ?? {}, c.facets, ctx.now);
    // How well the video's concepts match your taste, through the learned ranking model.
    const affinity = ctx.conceptProfile ? conceptAffinity(ctx.conceptProfile, conceptsOf(c), ctx.now) : 0;
    if (ctx.weights) s *= 0.5 + predict(ctx.weights, features(c, affinity, ctx.now));
    else s *= 1 + Math.max(-0.5, Math.min(1.5, affinity)) * 0.3;
    // Exploring: for topics one step away or further, bet on uncertain ones in proportion
    // to how well they might land (Thompson sampling on how often the topic was finished).
    if (t && (c.tier === 'adjacent' || c.tier === 'wildcard')) s *= 0.6 + 0.8 * sampleRate(t.watches, t.exposures, rng);
    // A little randomness so two equally good videos don't always tie the same way.
    s *= 0.8 + rng() * 0.4;
    return s;
  };
}

function historyToCandidate(w: WatchRecord): Candidate {
  return {
    id: w.videoId,
    title: w.title,
    channelId: w.channelId,
    channelTitle: w.channelTitle,
    publishedAt: '',
    durationSec: w.durationSec,
    views: 0,
    likes: 0,
    comments: 0,
    thumb: w.thumb,
    topic: w.topic,
    tier: w.tier,
    because: 'You watched this to the end',
    query: '',
    fetchedAt: w.at,
    facets: w.facets,
  };
}

export interface FeedOptions {
  note?: string;
  /** What the viewer asked for; gets its own row at the top. */
  focus?: string;
  customRows?: CustomRow[];
}

export function assembleFeed(pool: Candidate[], ctx: FeedContext, date: string, opts: FeedOptions = {}): DailyFeed {
  const used = newUsed();
  const score = makeScorer(ctx);
  const main = pool.filter((c) => c.tier !== 'shorts' && eligible(c, ctx));
  const byTier = (tier: Candidate['tier']) => main.filter((c) => c.tier === tier);
  const coldStart = coreInterests(ctx.profile, ctx.now).length === 0;

  const rows: FeedRow[] = [];
  const addRow = (row: FeedRow) => {
    if (row.items.length > 0) rows.push(row);
  };

  if (opts.focus) {
    addRow({
      id: 'focus',
      title: 'Because you asked',
      subtitle: opts.focus,
      items: pick(byTier('focus'), 8, used, score, { channelCap: 1, topicCap: 4 }),
    });
  }

  addRow({
    id: 'core',
    title: coldStart ? 'A taste of everything' : 'Picked for you',
    subtitle: coldStart
      ? 'Sampling widely while Wander learns what you like'
      : 'More of what you enjoy, from corners you haven’t seen',
    items: pick(byTier('core'), opts.focus ? 6 : 8, used, score),
  });
  for (const row of opts.customRows ?? []) {
    addRow({
      id: `custom-${row.id}`,
      title: row.title,
      subtitle: row.brief,
      items: pick(main.filter((c) => c.tier === 'custom' && c.rowId === row.id), 5, used, score, { channelCap: 1, topicCap: 5 }),
    });
  }
  addRow({
    id: 'adjacent',
    title: 'Next door',
    subtitle: 'One step away from your interests',
    items: pick(byTier('adjacent'), 7, used, score),
  });
  addRow({
    id: 'wildcard',
    title: 'Something completely different',
    subtitle: 'Deliberate wildcards. Skip freely.',
    items: pick(byTier('wildcard'), 6, used, score),
  });
  addRow({
    id: 'gems',
    title: 'Hidden gems',
    subtitle: 'Few views, lots of love',
    items: pick(main.filter(isHiddenGem), 5, used, (c) => score(c) * (1 + likeRatio(c) * 10)),
  });
  addRow({
    id: 'archive',
    title: 'From the archive',
    subtitle: 'Older videos that still hold up',
    items: pick(main.filter((c) => c.tier === 'archive' || isArchive(c)), 5, used, score),
  });

  const again = watchAgainCandidates(ctx.history, ctx.now)
    .filter((w) => !ctx.mutedChannels.has(w.channelId))
    .slice(0, 12);
  // Rotate through finished videos rather than always showing the latest ones.
  const rng = ctx.rng ?? Math.random;
  const againPicks = again
    .map((w) => ({ w, r: rng() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, 5)
    .map(({ w }) => historyToCandidate(w));
  addRow({ id: 'again', title: 'Watch again', subtitle: 'Ones you finished a while back', items: againPicks });

  const shortsPool = pool.filter((c) => c.tier === 'shorts' && eligible(c, ctx, true));
  const shorts = pick(shortsPool, 10, used, score, { channelCap: 1, topicCap: 3 });

  return { date, generatedAt: ctx.now, rows, shorts, surprisesUsed: 0, plannerNote: opts.note ?? '', focus: opts.focus };
}

/** A small extra row of wildcards on request, capped per day by the caller. */
export function assembleSurprise(pool: Candidate[], ctx: FeedContext, alreadyInFeed: Set<string>, n = 5): Candidate[] {
  const used = newUsed();
  alreadyInFeed.forEach((id) => used.ids.add(id));
  const score = makeScorer(ctx);
  return pick(
    pool.filter((c) => c.tier === 'wildcard' && eligible(c, ctx)),
    n,
    used,
    score,
    { channelCap: 1, topicCap: 1 },
  );
}

/** Related videos for the player screen, drawn from the cached pool (no extra API cost). */
export function relatedFromPool(
  pool: Candidate[],
  current: Candidate,
  ctx: FeedContext,
  exclude: Set<string>,
): { sameTopic: Candidate[]; elsewhere: Candidate[] } {
  const score = makeScorer(ctx);
  const used = newUsed();
  exclude.forEach((id) => used.ids.add(id));
  used.ids.add(current.id);
  const main = pool.filter((c) => c.tier !== 'shorts' && eligible(c, ctx));
  const key = normalizeTopic(current.topic);
  const sameTopic = pick(
    main.filter((c) => normalizeTopic(c.topic) === key),
    4,
    used,
    score,
    { channelCap: 2, topicCap: 4 },
  );
  const elsewhere = pick(
    main.filter((c) => normalizeTopic(c.topic) !== key && (c.tier === 'wildcard' || c.tier === 'adjacent')),
    2,
    used,
    score,
  );
  return { sameTopic, elsewhere };
}
