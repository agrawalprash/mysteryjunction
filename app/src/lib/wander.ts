// App state and the daily pipeline:
//   plan (Claude) -> search (YouTube) -> describe (Claude) -> pick (engine) -> remember.
// Plus a weekly taste profile written by Claude from the viewer's history.

import type { Candidate, DailyFeed, Direction, ExitRecord, TasteProfile, WatchRecord } from '../engine/types.ts';
import {
  addFacetSignal,
  addSignal,
  coreInterests,
  IGNORED_SIGNAL,
  LESS_LIKE_THIS_SIGNAL,
  rankTopics,
  recentMisses,
  SEARCH_SIGNAL,
  watchSignal,
  type Profile,
} from '../engine/profile.ts';
import { assembleFeed, assembleSurprise, eligible, relatedFromPool, type FeedContext } from '../engine/feed.ts';
import { SHORTS_TOPICS, WILDCARD_TOPICS, sampleWithout } from '../engine/fallbackTopics.ts';
import { load, localDate, remove, save } from './store.ts';
import { AUTO_BUDGET, fetchDirection, quotaUsed, searchIds, videoDetails, YouTubeError } from './youtube.ts';
import { describeVideos, planDay, planSurprise, writeTasteProfile, type ClaudeAuth, type PlannerInput } from './claude.ts';
import { claudeAuth, type ApiKeys } from './keys.ts';
import { getSettings } from './settings.ts';

const DAY = 24 * 60 * 60 * 1000;
export const SURPRISES_PER_DAY = 3;
/** Most videos Claude describes in one go (about 5 parallel batches). */
const MAX_DESCRIBE = 200;

interface State {
  profile: Profile;
  facetProfile: Profile;
  history: WatchRecord[];
  exits: ExitRecord[];
  dismissed: string[];
  shownCounts: Record<string, number>;
  pool: Candidate[];
  feed: DailyFeed | null;
  opened: string[]; // videos opened from the current feed
  muted: string[];
  searches: { q: string; at: number }[];
  recentTopics: { name: string; at: number }[];
  taste: TasteProfile | null;
}

function fresh(): State {
  return {
    profile: {},
    facetProfile: {},
    history: [],
    exits: [],
    dismissed: [],
    shownCounts: {},
    pool: [],
    feed: null,
    opened: [],
    muted: [],
    searches: [],
    recentTopics: [],
    taste: null,
  };
}

// Older saves may lack newer fields; fill them in.
let state: State = { ...fresh(), ...load<Partial<State>>('state', {}) };

function persist() {
  // Keep storage bounded.
  const now = Date.now();
  state.history = state.history.slice(-500);
  state.exits = state.exits.slice(-200);
  state.dismissed = state.dismissed.slice(-50);
  state.pool = state.pool.filter((c) => now - c.fetchedAt < 6 * DAY).slice(-800);
  state.searches = state.searches.slice(-30);
  state.recentTopics = state.recentTopics.filter((t) => now - t.at < 7 * DAY).slice(-120);
  const shownIds = Object.keys(state.shownCounts);
  if (shownIds.length > 4000) {
    for (const id of shownIds.slice(0, shownIds.length - 4000)) delete state.shownCounts[id];
  }
  save('state', state);
}

export function getState(): Readonly<State> {
  return state;
}

function ctx(): FeedContext {
  return {
    profile: state.profile,
    facetProfile: state.facetProfile,
    now: Date.now(),
    shownCounts: state.shownCounts,
    watchedIds: new Set(state.history.map((h) => h.videoId)),
    mutedChannels: new Set(state.muted),
    history: state.history,
  };
}

function plannerInput(): PlannerInput {
  const now = Date.now();
  return {
    interests: coreInterests(state.profile, now).map((t) => ({ name: t.name, score: t.score })),
    misses: recentMisses(state.profile, now).map((t) => t.name),
    recentWatches: state.history.slice(-15).map((h) => ({ title: h.title, topic: h.topic, fraction: h.fraction })),
    recentSearches: state.searches.slice(-8).map((s) => s.q),
    recentTopics: [...new Set(state.recentTopics.map((t) => t.name))].slice(-60),
    formatLeanings: rankTopics(state.facetProfile, now)
      .filter((t) => Math.abs(t.score) > 0.15)
      .slice(0, 10)
      .map((t) => ({ name: t.name, score: t.score })),
    taste: state.taste,
    language: getSettings().language,
  };
}

const ANGLES = ['', 'explained', 'history of', 'how it works', 'masterclass', 'behind the scenes', 'documentary'];

function offlinePlan(): Direction[] {
  const now = Date.now();
  const recent = new Set(state.recentTopics.map((t) => t.name));
  const interests = coreInterests(state.profile, now).slice(0, 5);
  const pickAngle = () => ANGLES[Math.floor(Math.random() * ANGLES.length)];
  const core: Direction[] = interests.length
    ? interests.map((t) => ({ topic: t.name, query: `${pickAngle()} ${t.name}`.trim(), tier: 'core', because: `Because you like ${t.name}` }))
    : sampleWithout(WILDCARD_TOPICS, 5, recent).map((t) => ({ topic: t, query: t, tier: 'core', because: 'Sampling widely' }));
  const used = new Set([...recent, ...core.map((c) => c.topic)]);
  const wild = sampleWithout(WILDCARD_TOPICS, 9, used);
  return [
    ...core,
    ...wild.slice(0, 4).map((t): Direction => ({ topic: t, query: `${pickAngle()} ${t}`.trim(), tier: 'adjacent', because: 'Something new to try' })),
    ...wild.slice(4, 8).map((t): Direction => ({ topic: t, query: t, tier: 'wildcard', because: 'A wildcard' })),
    ...wild.slice(8, 9).map((t): Direction => ({ topic: t, query: t, tier: 'archive', because: 'An older classic' })),
    ...sampleWithout(SHORTS_TOPICS, 3, new Set()).map((t): Direction => ({ topic: t, query: `${t} #shorts`, tier: 'shorts', because: 'Quick one' })),
  ];
}

async function runDirections(directions: Direction[], keys: ApiKeys, onProgress: (msg: string) => void): Promise<Candidate[]> {
  const affordable = Math.max(0, Math.floor((AUTO_BUDGET - quotaUsed()) / 101));
  const todo = directions.slice(0, affordable);
  if (todo.length === 0) throw new Error('Today’s YouTube quota is used up. New videos tomorrow.');
  const results: Candidate[] = [];
  let done = 0;
  let firstError: unknown = null;
  const queue = [...todo];
  const language = getSettings().language;
  const worker = async () => {
    while (queue.length) {
      const d = queue.shift()!;
      try {
        results.push(...(await fetchDirection(d, keys.youtube, language)));
      } catch (e) {
        firstError ??= e;
        // A bad key or exhausted quota won't fix itself mid-run.
        if (e instanceof YouTubeError && (e.status === 400 || e.status === 403)) queue.length = 0;
      }
      done += 1;
      onProgress(`Exploring ${done} of ${todo.length} directions…`);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  if (results.length === 0 && firstError) throw firstError;
  return results;
}

/** Ask Claude to describe the videos that could actually be shown and aren't described yet. */
async function describe(found: Candidate[], auth: ClaudeAuth | null, onProgress: (msg: string) => void) {
  if (!auth) return;
  const c = ctx();
  const known = new Map(state.pool.filter((p) => p.facets).map((p) => [p.id, p.facets!]));
  for (const v of found) if (!v.facets && known.has(v.id)) v.facets = known.get(v.id);
  const todo = found
    .filter((v) => !v.facets && eligible(v, c, v.tier === 'shorts'))
    .slice(0, MAX_DESCRIBE);
  if (todo.length === 0) return;
  onProgress(`Claude is looking at ${todo.length} videos…`);
  const facets = await describeVideos(auth, todo);
  for (const v of found) if (facets[v.id]) v.facets = facets[v.id];
}

function mergePool(incoming: Candidate[]) {
  const byId = new Map(state.pool.map((c) => [c.id, c]));
  for (const c of incoming) byId.set(c.id, { ...c, facets: c.facets ?? byId.get(c.id)?.facets });
  state.pool = [...byId.values()];
}

function feedIds(feed: DailyFeed | null): string[] {
  if (!feed) return [];
  return [...feed.rows.flatMap((r) => r.items.map((i) => i.id)), ...feed.shorts.map((s) => s.id)];
}

/** Learn a little from yesterday's feed: things never opened were mild "no"s. */
function settlePreviousFeed() {
  const feed = state.feed;
  if (!feed) return;
  const opened = new Set(state.opened);
  const now = Date.now();
  for (const row of feed.rows) {
    if (row.id === 'again') continue;
    for (const c of row.items) {
      if (!opened.has(c.id)) state.profile = addSignal(state.profile, c.topic, IGNORED_SIGNAL, now, c.tier, { exposed: true });
    }
  }
}

export function todaysFeed(): DailyFeed | null {
  return state.feed && state.feed.date === localDate() ? state.feed : null;
}

let building: Promise<DailyFeed> | null = null;

/** Builds today's feed once; concurrent callers share the same run. */
export function buildTodaysFeed(keys: ApiKeys, onProgress: (msg: string) => void): Promise<DailyFeed> {
  const existing = todaysFeed();
  if (existing) return Promise.resolve(existing);
  building ??= buildFeed(keys, onProgress).finally(() => {
    building = null;
  });
  return building;
}

async function buildFeed(keys: ApiKeys, onProgress: (msg: string) => void): Promise<DailyFeed> {
  const auth = claudeAuth(keys);
  let directions: Direction[];
  let note = '';
  if (auth) {
    onProgress('Asking Claude for fresh directions…');
    try {
      const plan = await planDay(auth, plannerInput());
      directions = plan.directions;
      note = plan.note;
    } catch (e) {
      console.warn('Planner failed, using offline topics', e);
      directions = offlinePlan();
      note = 'Claude was unavailable, so today’s mix uses simpler topic picks.';
    }
  } else {
    directions = offlinePlan();
  }

  onProgress(`Exploring ${directions.length} directions…`);
  const found = await runDirections(directions, keys, onProgress);
  await describe(found, auth, onProgress);
  onProgress('Picking today’s set…');

  settlePreviousFeed();
  mergePool(found);
  const feed = assembleFeed(state.pool, ctx(), localDate(), note);
  const now = Date.now();
  for (const id of feedIds(feed)) state.shownCounts[id] = (state.shownCounts[id] ?? 0) + 1;
  for (const d of directions) state.recentTopics.push({ name: d.topic, at: now });
  state.feed = feed;
  state.opened = [];
  persist();
  // Weekly: refresh Claude's read on your taste in the background, for tomorrow's plan.
  void maybeRefreshTaste(keys).catch((e) => console.warn('Taste profile refresh failed', e));
  return feed;
}

export async function surprise(keys: ApiKeys, onProgress: (msg: string) => void): Promise<DailyFeed> {
  const feed = todaysFeed();
  if (!feed) throw new Error('No feed yet');
  if (feed.surprisesUsed >= SURPRISES_PER_DAY) return feed;
  const auth = claudeAuth(keys);
  let directions: Direction[] = [];
  onProgress('Finding something unexpected…');
  if (auth) {
    try {
      directions = await planSurprise(auth, plannerInput());
    } catch {
      directions = [];
    }
  }
  if (directions.length === 0) {
    const recent = new Set(state.recentTopics.map((t) => t.name));
    directions = sampleWithout(WILDCARD_TOPICS, 3, recent).map((t) => ({ topic: t, query: t, tier: 'wildcard', because: 'A wildcard' }));
  }
  const found = await runDirections(directions, keys, onProgress);
  await describe(found, auth, onProgress);
  mergePool(found);
  // Only use what this surprise just found, so it's genuinely new.
  const items = assembleSurprise(found, ctx(), new Set(feedIds(feed)));
  const now = Date.now();
  for (const c of items) state.shownCounts[c.id] = (state.shownCounts[c.id] ?? 0) + 1;
  for (const d of directions) state.recentTopics.push({ name: d.topic, at: now });
  feed.surprisesUsed += 1;
  if (items.length) {
    feed.rows.push({ id: `surprise-${feed.surprisesUsed}`, title: 'Surprise', subtitle: 'You asked for it', items });
  }
  state.feed = { ...feed };
  persist();
  return state.feed;
}

// ---------------------------------------------------------------- taste profile

let tasteRun: Promise<TasteProfile | null> | null = null;

/** Rewrite the taste profile weekly (or when forced), once there's enough history. */
export function maybeRefreshTaste(keys: ApiKeys, force = false): Promise<TasteProfile | null> {
  const auth = claudeAuth(keys);
  if (!auth) return Promise.resolve(null);
  const t = state.taste;
  const enoughHistory = state.history.length >= 5;
  const stale = !t || (Date.now() - t.generatedAt > 7 * DAY && state.history.length - t.watchesSeen >= 3);
  if (!force && !(enoughHistory && stale)) return Promise.resolve(t);
  if (force && state.history.length === 0) throw new Error('Watch a few videos first.');
  tasteRun ??= writeTasteProfile(auth, {
    watches: state.history.slice(-150),
    exits: state.exits.slice(-60),
    searches: state.searches.slice(-20).map((s) => s.q),
    dismissed: state.dismissed,
    previous: state.taste,
  })
    .then((profile) => {
      state.taste = { ...profile, watchesSeen: state.history.length };
      persist();
      return state.taste;
    })
    .finally(() => {
      tasteRun = null;
    });
  return tasteRun;
}

// ---------------------------------------------------------------- signals

export function markOpened(c: Candidate) {
  if (!state.opened.includes(c.id)) state.opened.push(c.id);
  persist();
}

export function recordWatch(c: Candidate, watchedSec: number, durationSec: number) {
  const dur = durationSec || c.durationSec;
  const fraction = dur > 0 ? Math.min(1, watchedSec / dur) : 0;
  const now = Date.now();
  const signal = watchSignal(watchedSec, dur);
  state.profile = addSignal(state.profile, c.topic, signal, now, c.tier, { watched: watchedSec >= 20, exposed: true });
  state.facetProfile = addFacetSignal(state.facetProfile, c.facets, signal, now);
  if (watchedSec >= 20) {
    state.history = state.history.filter((h) => !(h.videoId === c.id && now - h.at < DAY));
    state.history.push({
      videoId: c.id,
      title: c.title,
      channelId: c.channelId,
      channelTitle: c.channelTitle,
      thumb: c.thumb,
      durationSec: dur,
      topic: c.topic,
      tier: c.tier,
      watchedSec,
      fraction,
      at: now,
      facets: c.facets,
    });
  } else {
    state.exits.push({ title: c.title, topic: c.topic, facets: c.facets, at: now });
  }
  persist();
}

export function lessLikeThis(c: Candidate) {
  const now = Date.now();
  state.profile = addSignal(state.profile, c.topic, LESS_LIKE_THIS_SIGNAL, now, c.tier);
  state.facetProfile = addFacetSignal(state.facetProfile, c.facets, LESS_LIKE_THIS_SIGNAL / 2, now);
  state.dismissed.push(c.facets ? `${c.topic} (${c.facets.subject}, ${c.facets.format})` : c.topic);
  state.shownCounts[c.id] = (state.shownCounts[c.id] ?? 0) + 3;
  persist();
}

export function hideChannel(c: Candidate) {
  if (!state.muted.includes(c.channelId)) state.muted.push(c.channelId);
  if (state.feed) {
    state.feed = {
      ...state.feed,
      rows: state.feed.rows.map((r) => ({ ...r, items: r.items.filter((i) => i.channelId !== c.channelId) })),
      shorts: state.feed.shorts.filter((i) => i.channelId !== c.channelId),
    };
  }
  persist();
}

export function related(c: Candidate) {
  return relatedFromPool(state.pool, c, ctx(), new Set([...feedIds(state.feed), ...state.opened]));
}

export async function search(q: string, keys: ApiKeys): Promise<Candidate[]> {
  const query = q.trim();
  if (!query) return [];
  const now = Date.now();
  state.searches.push({ q: query, at: now });
  state.profile = addSignal(state.profile, query, SEARCH_SIGNAL, now, 'search');
  persist();
  const ids = await searchIds(query, keys.youtube, { maxResults: 20, language: getSettings().language });
  const videos = await videoDetails(ids, keys.youtube);
  const results = videos.map((v) => ({ ...v, topic: query, tier: 'search' as const, because: `You searched “${query}”`, query, fetchedAt: now }));
  mergePool(results);
  persist();
  return results;
}

export function resetLearning() {
  remove('state');
  state = fresh();
  persist();
}

/** Throw away today's feed so the next open builds a new one (costs quota). */
export function rebuildToday() {
  if (state.feed) state.feed = { ...state.feed, date: '' };
  persist();
}
