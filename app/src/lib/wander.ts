// App state and the pipeline, built around a fixed-size pool of videos on the device:
//   background refill:  plan (Claude) -> fetch (YouTube, mostly cheap channel reads)
//                       -> describe + concept-tag (Claude) -> add to pool, trim to size
//   new set (instant):  rank the pool on the device (concept taste, learned model,
//                       exploration) -> pick with variety rules -> show
// Refills happen while the app is open: after you watch things, when you come back,
// and every 20 minutes. Plus a weekly taste profile, and things you tell Wander.

import type { Candidate, CustomRow, DailyFeed, Direction, ExitRecord, TasteProfile, WatchRecord } from '../engine/types.ts';
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
import { assembleFeed, assembleSurprise, eligible, makeScorer, relatedFromPool, type FeedContext } from '../engine/feed.ts';
import { addConceptSignal, conceptAffinity, conceptsOf, features, initialWeights, topConcepts, update, FEATURES, type Weights } from '../engine/learn.ts';
import { canMakeSet, matchPool, needsRefill, poolHealth, POOL_SIZE, trimPool } from '../engine/pool.ts';
import { SHORTS_TOPICS, WILDCARD_TOPICS, sampleWithout } from '../engine/fallbackTopics.ts';
import { load, localDate, remove, save } from './store.ts';
import { AUTO_BUDGET, channelUploads, fetchDirection, quotaUsed, searchIds, SET_COST, videoDetails, YouTubeError } from './youtube.ts';
import { askWander, describeVideos, explainPicks, planDay, planSurprise, suggestAsks, writeTasteProfile, type ClaudeAuth, type PlannerInput, type Suggestion } from './claude.ts';
import { claudeAuth, type ApiKeys } from './keys.ts';
import { pathId, type MapPlace } from './map.ts';
import { getSettings } from './settings.ts';
import { timeStatus, type TimeStatus } from './screenTime.ts';
import { activeProfile, deleteProfile, listProfiles, setActiveProfileId, stateKey, type WanderProfile } from './profiles.ts';

const DAY = 24 * 60 * 60 * 1000;
export const SURPRISES_PER_DAY = 3;
/** Most videos Claude describes in one go (about 5 parallel batches). */
const MAX_DESCRIBE = 200;
/** When you're waiting, describe only the likeliest picks first; the rest follow in the background. */
const QUICK_DESCRIBE = 60;

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
  /** Things you told Wander to remember. */
  pinned: string[];
  rules: string[];
  customRows: CustomRow[];
  asks: { text: string; reply: string; at: number }[];
  /** YouTube quota units the last few fetches actually cost. */
  setCosts: number[];
  /** Taste over Claude's concept tags. */
  conceptProfile: Profile;
  /** The on-device ranking model. */
  weights: Weights;
  /** Claude's suggestions for the Ask panel. */
  suggestions: { at: number; items: Suggestion[] } | null;
  lastRefill: number;
  watchesSinceRefill: number;
  /** Explore's map: places opened, videos watched from each place, and fetched videos per place. */
  mapVisits: Record<string, { path: string[]; at: number }>;
  mapWatch: Record<string, number>;
  /** Each place's own YouTube search results, kept for a week (newest places last). */
  mapVideos: Record<string, { at: number; videos?: Candidate[]; ids?: string[] }>;
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
    pinned: [],
    rules: [],
    customRows: [],
    asks: [],
    setCosts: [],
    conceptProfile: {},
    weights: initialWeights(),
    suggestions: null,
    lastRefill: 0,
    watchesSinceRefill: 0,
    mapVisits: {},
    mapWatch: {},
    mapVideos: {},
  };
}

function loadState(): State {
  // Older saves may lack newer fields; fill them in.
  const s: State = { ...fresh(), ...load<Partial<State>>(stateKey(), {}) };
  if (!Array.isArray(s.weights) || s.weights.length !== FEATURES.length) s.weights = initialWeights();
  return s;
}

/** The active profile's taste, pool and history. Each profile has its own. */
let state: State = loadState();
/** Bumped on every profile switch, so work started for one profile never lands in another's. */
let generation = 0;

/** One online-learning step for the ranking model. */
function learn(c: Candidate, y: 0 | 1, weight: number) {
  const affinity = conceptAffinity(state.conceptProfile, conceptsOf(c), Date.now());
  state.weights = update(state.weights, features(c, affinity), y, weight);
}

// Lets screens know when the set on screen changes (e.g. after a request from the phone).
const listeners = new Set<() => void>();
export function onFeedChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emitFeedChanged() {
  listeners.forEach((fn) => fn());
}

function persist() {
  // Keep storage bounded.
  const now = Date.now();
  state.history = state.history.slice(-500);
  state.exits = state.exits.slice(-200);
  state.dismissed = state.dismissed.slice(-50);
  // The pool is trimmed by value when videos are added; this is only a safety cap.
  if (state.pool.length > POOL_SIZE + 400) state.pool = state.pool.slice(-(POOL_SIZE + 400));
  state.searches = state.searches.slice(-30);
  state.asks = state.asks.slice(-20);
  state.recentTopics = state.recentTopics.filter((t) => now - t.at < 7 * DAY).slice(-120);
  const shownIds = Object.keys(state.shownCounts);
  if (shownIds.length > 4000) {
    for (const id of shownIds.slice(0, shownIds.length - 4000)) delete state.shownCounts[id];
  }
  save(stateKey(), state);
}

export function getState(): Readonly<State> {
  return state;
}

function ctx(): FeedContext {
  return {
    profile: state.profile,
    facetProfile: state.facetProfile,
    conceptProfile: state.conceptProfile,
    weights: state.weights,
    now: Date.now(),
    shownCounts: state.shownCounts,
    watchedIds: new Set(state.history.map((h) => h.videoId)),
    mutedChannels: new Set(state.muted),
    history: state.history,
    kidCheck: activeProfile().options.contentCheck,
  };
}

function plannerInput(focus = '', refill = false): PlannerInput {
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
    pinned: state.pinned,
    rules: state.rules,
    customRows: state.customRows,
    focus,
    refill,
    language: getSettings().language,
  };
}

const ANGLES = ['', 'explained', 'history of', 'how it works', 'masterclass', 'behind the scenes', 'documentary'];

function offlinePlan(focus = ''): Direction[] {
  const now = Date.now();
  const recent = new Set(state.recentTopics.map((t) => t.name));
  const interests = [...state.pinned.map((name) => ({ name })), ...coreInterests(state.profile, now)].slice(0, 5);
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
    ...state.customRows.map((r): Direction => ({ topic: r.title, query: r.title, tier: 'custom', because: r.title, rowId: r.id })),
    ...(focus ? ANGLES.slice(0, 4).map((a): Direction => ({ topic: focus, query: `${a} ${focus}`.trim(), tier: 'focus', because: 'You asked for this' })) : []),
  ];
}

async function runDirections(directions: Direction[], keys: ApiKeys, onProgress: (msg: string) => void): Promise<Candidate[]> {
  // Worst case each direction falls back to a 100-unit search.
  const affordable = Math.max(0, Math.floor((AUTO_BUDGET - quotaUsed()) / 103));
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
async function describe(found: Candidate[], auth: ClaudeAuth | null, onProgress: (msg: string) => void, limit = MAX_DESCRIBE) {
  if (!auth) return;
  // Undescribed videos can't pass the kid check yet, so pick what to describe without it.
  const kid = !!ctx().kidCheck;
  const c = { ...ctx(), kidCheck: false };
  const complete = (f?: Candidate['facets']) => !!f?.concepts && (!kid || f.kidSafe !== undefined);
  // Reuse descriptions we already have (only complete ones).
  const known = new Map(state.pool.filter((p) => complete(p.facets)).map((p) => [p.id, p.facets!]));
  for (const v of found) if (!complete(v.facets) && known.has(v.id)) v.facets = known.get(v.id);
  // Likeliest picks first, so a limited run covers what will actually be shown.
  const score = makeScorer({ ...c, rng: () => 0.5 });
  const todo = found
    .filter((v) => !complete(v.facets) && eligible(v, c, v.tier === 'shorts'))
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
  if (todo.length === 0) return;
  onProgress(`Claude is looking at ${todo.length} videos…`);
  const facets = await describeVideos(auth, todo, conceptVocabulary());
  for (const v of found) if (facets[v.id]) v.facets = facets[v.id];
}

/** Concepts already in use (your strongest ones, then the most common in the pool), so tags stay consistent. */
function conceptVocabulary(): string[] {
  const counts = new Map<string, number>();
  for (const c of state.pool) for (const k of conceptsOf(c)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return [...new Set([...topConcepts(state.conceptProfile, Date.now(), 60), ...common])].slice(0, 150);
}

function mergePool(incoming: Candidate[]) {
  const byId = new Map(state.pool.map((c) => [c.id, c]));
  for (const c of incoming) {
    const facets = c.facets ?? byId.get(c.id)?.facets;
    // Once Claude has described a video, its description text isn't needed; keep storage small.
    byId.set(c.id, { ...c, facets, description: facets ? undefined : c.description?.slice(0, 200) });
  }
  state.pool = trimPool([...byId.values()], ctx());
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
      if (!opened.has(c.id)) {
        state.profile = addSignal(state.profile, c.topic, IGNORED_SIGNAL, now, c.tier, { exposed: true });
        learn(c, 0, 0.15);
      }
    }
  }
}

export function todaysFeed(): DailyFeed | null {
  return state.feed && state.feed.date === localDate() ? state.feed : null;
}

let building: Promise<DailyFeed> | null = null;

/** Today's set, made on first open of the day. Concurrent callers share one run. */
export function buildTodaysFeed(keys: ApiKeys, onProgress: (msg: string) => void): Promise<DailyFeed> {
  const existing = todaysFeed();
  if (existing) return Promise.resolve(existing);
  return newSet(keys, '', onProgress);
}

/** Typical quota cost of one fetch round, from recent ones (channel reads are much cheaper than searches). */
export function setCost(): number {
  const recent = state.setCosts.slice(-5);
  if (recent.length === 0) return SET_COST;
  return Math.max(200, Math.round(recent.reduce((a, b) => a + b, 0) / recent.length));
}

/** Rough number of new sets available now: from the pool (free) plus what today's quota could fetch. */
export function setsLeftToday(): number {
  const h = poolHealth(state.pool, ctx());
  return Math.floor(h.freshMain / 30) + Math.max(0, Math.floor((AUTO_BUDGET - quotaUsed()) / setCost()));
}

export function poolStatus() {
  const h = poolHealth(state.pool, ctx());
  return { ...h, size: POOL_SIZE, lastRefill: state.lastRefill, refilling: !!refilling };
}

/**
 * Show a new set now. Normally it's made instantly from the pool. With a focus ("music")
 * or when the pool is too thin (first run), videos are fetched first.
 */
export function newSet(keys: ApiKeys, focus: string, onProgress: (msg: string) => void, mustBeFresh = false): Promise<DailyFeed> {
  focus = focus.trim();
  building ??= (async () => {
    if (!focus && !mustBeFresh && canMakeSet(poolHealth(state.pool, ctx()))) {
      const feed = install([], [], '', '');
      afterShowing(keys, []);
      return feed;
    }
    if (quotaUsed() + setCost() > AUTO_BUDGET) throw new Error('YouTube’s daily limit is used up and your pool is thin. More tomorrow.');
    const gen = generation;
    const { found, directions, note } = await gather(keys, focus, onProgress, true);
    if (gen !== generation) throw new Error('Switched profile while the set was being made.');
    onProgress('Picking your set…');
    const feed = install(found, directions, note, focus);
    afterShowing(keys, found);
    return feed;
  })().finally(() => {
    building = null;
  });
  return building;
}

async function gather(keys: ApiKeys, focus: string, onProgress: (msg: string) => void, quick: boolean, refill = false) {
  const auth = claudeAuth(keys);
  let directions: Direction[];
  let note = '';
  if (auth) {
    onProgress(focus ? 'Claude is planning around your request…' : 'Asking Claude for fresh directions…');
    try {
      const plan = await planDay(auth, plannerInput(focus, refill));
      directions = plan.directions;
      note = plan.note;
    } catch (e) {
      console.warn('Planner failed, using offline topics', e);
      directions = offlinePlan(focus);
      note = 'Claude was unavailable, so this mix uses simpler topic picks.';
    }
  } else {
    directions = offlinePlan(focus);
  }
  onProgress(`Exploring ${directions.length} directions…`);
  const before = quotaUsed();
  const found = await runDirections(directions, keys, onProgress);
  if (!focus) found.push(...(await fromFavouriteChannels(keys).catch(() => [])));
  state.setCosts = [...state.setCosts, quotaUsed() - before].slice(-10);
  await describe(found, auth, onProgress, quick ? QUICK_DESCRIBE : MAX_DESCRIBE);
  return { found, directions, note };
}

/** Turn the pool (plus anything just fetched) into the set on screen. `extra` are focus picks. */
function install(found: Candidate[], directions: Direction[], note: string, focus: string, extra: Candidate[] = []): DailyFeed {
  settlePreviousFeed();
  mergePool(found);
  const feed = assembleFeed([...extra, ...state.pool], ctx(), localDate(), { note, focus, customRows: state.customRows, familiar: activeProfile().options.familiar });
  const now = Date.now();
  for (const id of feedIds(feed)) state.shownCounts[id] = (state.shownCounts[id] ?? 0) + 1;
  for (const d of directions) state.recentTopics.push({ name: d.topic, at: now });
  state.feed = feed;
  state.opened = [];
  persist();
  emitFeedChanged();
  return feed;
}

/** Background work after a set is on screen: finish describing, top up the pool, refresh taste. */
function afterShowing(keys: ApiKeys, found: Candidate[]) {
  const auth = claudeAuth(keys);
  const gen = generation;
  void (async () => {
    // Describe anything still undescribed (just fetched, or left from before).
    // (Videos described before concept tags existed get tagged too, a batch at a time.)
    const kid = activeProfile().options.contentCheck;
    const undescribed = [...found, ...state.pool].filter((c) => !c.facets?.concepts || (kid && c.facets.kidSafe === undefined)).slice(0, MAX_DESCRIBE);
    if (auth && undescribed.length) {
      await describe(undescribed, auth, () => undefined).catch(() => undefined);
      if (gen !== generation) return;
      mergePool(undescribed);
      persist();
    }
    if (gen !== generation) return;
    if (auth) await explainFeed(auth).catch((e) => console.warn('Why lines failed', e));
    if (gen !== generation) return;
    await maybeRefill(keys).catch((e) => console.warn('Refill failed', e));
    if (gen !== generation) return;
    await maybeRefreshTaste(keys).catch((e) => console.warn('Taste profile refresh failed', e));
  })();
}

// ---------------------------------------------------------------- background refill

let refilling: Promise<void> | null = null;
let bgKeys: ApiKeys | null = null;
let watchTimer: ReturnType<typeof setTimeout> | undefined;
const REFILL_MIN_GAP = 8 * 60 * 1000;
/** Keep this much of the day's quota for searches you type. */
const SEARCH_RESERVE = 1500;

/** Top up the pool when it's thin, or when your recent watching suggests new directions. */
export function maybeRefill(keys: ApiKeys, force = false): Promise<void> {
  if (refilling) return refilling;
  const now = Date.now();
  const h = poolHealth(state.pool, ctx());
  const drift = state.watchesSinceRefill >= 3;
  const due = needsRefill(h) || (drift && now - state.lastRefill > 15 * 60 * 1000);
  if (!force && (!due || now - state.lastRefill < REFILL_MIN_GAP)) return Promise.resolve();
  if (quotaUsed() + setCost() > AUTO_BUDGET - SEARCH_RESERVE) return Promise.resolve();
  const gen = generation;
  refilling = (async () => {
    const { found, directions } = await gather(keys, '', () => undefined, false, true);
    if (gen !== generation) return;
    mergePool(found);
    for (const d of directions) state.recentTopics.push({ name: d.topic, at: Date.now() });
    state.lastRefill = Date.now();
    state.watchesSinceRefill = 0;
    persist();
  })().finally(() => {
    refilling = null;
  });
  return refilling;
}

/** Called once the app has keys: refill shortly after start, every 20 minutes, and after watching. */
export function startBackground(keys: ApiKeys) {
  const first = !bgKeys;
  bgKeys = keys;
  if (!first) return;
  setTimeout(() => bgKeys && void maybeRefill(bgKeys).catch(() => undefined), 15_000);
  setInterval(() => bgKeys && void maybeRefill(bgKeys).catch(() => undefined), 20 * 60 * 1000);
}

/** When the app comes back to the foreground. */
export function onResume() {
  if (bgKeys) void maybeRefill(bgKeys).catch(() => undefined);
}

// ---------------------------------------------------------------- talking to Wander

export interface AskOutcome {
  reply: string;
  feed: DailyFeed | null;
  changes: string[];
  /** Set when Claude's changes were saved but a new set couldn't be made (e.g. quota). */
  notice?: string;
  /** Claude decided this was really a search: what to search for. */
  search?: string;
}

/** Hand what the viewer said to Claude, apply what it decides, and make a new set if needed. */
export async function ask(keys: ApiKeys, text: string, onProgress: (msg: string) => void, browsing?: string[]): Promise<AskOutcome> {
  const auth = claudeAuth(keys);
  if (!auth) throw new Error('Talking to Wander needs an Anthropic key (Settings → Change API keys).');
  onProgress('Claude is listening…');
  const now = Date.now();
  const gen = generation;
  const r = await askWander(auth, {
    request: text,
    pinned: state.pinned,
    rules: state.rules,
    customRows: state.customRows,
    taste: state.taste,
    interests: coreInterests(state.profile, now).map((t) => t.name),
    currentFocus: state.feed?.focus ?? '',
    browsing: browsing?.join(' › '),
  });

  if (gen !== generation) throw new Error('Switched profile while Claude was thinking.');
  // Claude decided it was a plain search: hand it back to be searched, change nothing.
  if (r.search?.trim()) return { reply: r.reply, feed: null, changes: [], search: r.search.trim() };

  const changes: string[] = [];
  const lower = (x: string) => x.trim().toLowerCase();
  for (const t of r.remove_rows) {
    const before = state.customRows.length;
    state.customRows = state.customRows.filter((row) => lower(row.title) !== lower(t));
    if (state.customRows.length < before) changes.push(`Removed row “${t}”`);
  }
  for (const row of r.add_rows) {
    if (!row.title.trim() || state.customRows.some((x) => lower(x.title) === lower(row.title))) continue;
    state.customRows.push({ id: `${now}-${Math.random().toString(36).slice(2, 7)}`, title: row.title.trim(), brief: row.brief.trim() });
    changes.push(`New row “${row.title.trim()}”`);
  }
  state.customRows = state.customRows.slice(-4);
  for (const t of r.remove_interests) {
    const before = state.pinned.length;
    state.pinned = state.pinned.filter((p) => lower(p) !== lower(t));
    if (state.pinned.length < before) changes.push(`Forgot “${t}”`);
  }
  for (const t of r.add_interests) {
    if (!t.trim() || state.pinned.some((p) => lower(p) === lower(t))) continue;
    state.pinned.push(t.trim());
    // Counts as a strong, lasting interest straight away.
    state.profile = addSignal(state.profile, t, 1.5, now, 'core');
    changes.push(`Remembering “${t.trim()}”`);
  }
  for (const t of r.remove_rules) {
    const before = state.rules.length;
    state.rules = state.rules.filter((p) => lower(p) !== lower(t));
    if (state.rules.length < before) changes.push(`Dropped rule “${t}”`);
  }
  for (const t of r.add_rules) {
    if (!t.trim() || state.rules.some((p) => lower(p) === lower(t))) continue;
    state.rules.push(t.trim());
    changes.push(`New rule “${t.trim()}”`);
  }
  state.asks.push({ text, reply: r.reply, at: now });
  const settingsChanged = r.add_rows.length + r.remove_rows.length + r.add_rules.length + r.add_interests.length > 0;
  persist();

  let feed: DailyFeed | null = null;
  let notice: string | undefined;
  if (r.new_set || r.focus || r.add_rows.length) {
    try {
      // A mood or wish is served from the pool when it has enough matches: no YouTube calls.
      const fromPool = r.focus && !r.add_rows.length ? focusFromPool(r.focus, r.focus_concepts) : [];
      if (fromPool.length >= 8) {
        feed = install([], [], '', r.focus, fromPool);
        afterShowing(keys, []);
      } else {
        feed = await newSet(keys, r.focus, onProgress, settingsChanged);
      }
    } catch (e) {
      notice = `Saved, but no new set right now: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { reply: r.reply, feed, changes, notice };
}

/** Videos already in the pool that fit a request, as a "Because you asked" row (unseen ones first). */
function focusFromPool(focus: string, concepts: string[]): Candidate[] {
  const c = ctx();
  const matches = matchPool(state.pool, c, focus, concepts, 40).filter((m) => m.tier !== 'shorts');
  const unseen = matches.filter((m) => !(c.shownCounts[m.id] > 0));
  const seen = matches.filter((m) => c.shownCounts[m.id] > 0);
  return [...unseen, ...seen].map((m) => ({ ...m, tier: 'focus' as const, because: 'You asked for this' }));
}

/** Videos in the pool matching a search, shown instantly while YouTube is asked. */
export function searchPool(q: string): Candidate[] {
  return matchPool(state.pool, ctx(), q, [], 12).filter((c) => c.tier !== 'shorts');
}

/** Claude's tappable suggestions for the Ask panel, refreshed about daily. */
export async function getSuggestions(keys: ApiKeys, force = false): Promise<Suggestion[]> {
  const cached = state.suggestions;
  if (!force && cached && Date.now() - cached.at < 20 * 60 * 60 * 1000 && cached.items.length) return cached.items;
  const auth = claudeAuth(keys);
  if (!auth) return cached?.items ?? [];
  try {
    const items = await suggestAsks(auth, plannerInput());
    state.suggestions = { at: Date.now(), items };
    persist();
    return items;
  } catch {
    return cached?.items ?? [];
  }
}

/** Remove something you told Wander, from Settings. */
export function forget(kind: 'row' | 'interest' | 'rule', value: string) {
  if (kind === 'row') state.customRows = state.customRows.filter((r) => r.id !== value);
  if (kind === 'interest') state.pinned = state.pinned.filter((p) => p !== value);
  if (kind === 'rule') state.rules = state.rules.filter((p) => p !== value);
  persist();
}

export async function surprise(keys: ApiKeys, onProgress: (msg: string) => void): Promise<DailyFeed> {
  const feed = todaysFeed();
  if (!feed) throw new Error('No feed yet');
  if (feed.surprisesUsed >= SURPRISES_PER_DAY) return feed;
  // Unseen wildcards already in the pool first: instant and free.
  const fromPool = assembleSurprise(state.pool, ctx(), new Set(feedIds(feed)));
  if (fromPool.length >= 3) {
    for (const c of fromPool) state.shownCounts[c.id] = (state.shownCounts[c.id] ?? 0) + 1;
    feed.surprisesUsed += 1;
    feed.rows.push({ id: `surprise-${feed.surprisesUsed}`, title: 'Surprise', subtitle: 'You asked for it', items: fromPool });
    state.feed = { ...feed };
    persist();
    return state.feed;
  }
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
  const gen = generation;
  const found = await runDirections(directions, keys, onProgress);
  await describe(found, auth, onProgress);
  if (gen !== generation) throw new Error('Switched profile while looking for a surprise.');
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
  const gen = generation;
  tasteRun ??= writeTasteProfile(auth, {
    watches: state.history.slice(-150),
    exits: state.exits.slice(-60),
    searches: state.searches.slice(-20).map((s) => s.q),
    dismissed: state.dismissed,
    previous: state.taste,
  })
    .then((profile) => {
      if (gen !== generation) return null;
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
  const fromPlace = openedFrom.get(c.id);
  if (fromPlace && watchedSec >= 20) state.mapWatch[fromPlace] = (state.mapWatch[fromPlace] ?? 0) + 1;
  const dur = durationSec || c.durationSec;
  const fraction = dur > 0 ? Math.min(1, watchedSec / dur) : 0;
  const now = Date.now();
  const signal = watchSignal(watchedSec, dur);
  state.profile = addSignal(state.profile, c.topic, signal, now, c.tier, { watched: watchedSec >= 20, exposed: true });
  state.facetProfile = addFacetSignal(state.facetProfile, c.facets, signal, now);
  state.conceptProfile = addConceptSignal(state.conceptProfile, conceptsOf(c), signal * 0.8, now);
  // The ranking model learns from how it went: finished = yes, bailed early = no, in between = weak yes.
  if (fraction >= 0.5) learn(c, 1, 1);
  else if (watchedSec < 20) learn(c, 0, 1);
  else learn(c, 1, 0.3);
  // Your recent watching steers the next background refill.
  state.watchesSinceRefill += 1;
  if (bgKeys) {
    clearTimeout(watchTimer);
    const k = bgKeys;
    watchTimer = setTimeout(() => void maybeRefill(k).catch(() => undefined), 2 * 60 * 1000);
  }
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
  state.conceptProfile = addConceptSignal(state.conceptProfile, conceptsOf(c), LESS_LIKE_THIS_SIGNAL / 2, now);
  learn(c, 0, 1.5);
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
  let results: Candidate[] = videos.map((v) => ({ ...v, topic: query, tier: 'search' as const, because: `You searched “${query}”`, query, fetchedAt: now }));
  if (activeProfile().options.contentCheck) {
    // Kid profiles: Claude checks search results before any are shown.
    const auth = claudeAuth(keys);
    if (auth) await describe(results, auth, () => undefined);
    results = results.filter((r) => r.facets?.kidSafe === true);
  }
  mergePool(results);
  persist();
  return results;
}

export function resetLearning() {
  remove(stateKey());
  state = fresh();
  persist();
}

/** Throw away today's feed so the next open builds a new one (costs quota). */
export function rebuildToday() {
  if (state.feed) state.feed = { ...state.feed, date: '' };
  persist();
}

// ---------------------------------------------------------------- syncing what you told Wander

export interface Told {
  pinned: string[];
  rules: string[];
  customRows: CustomRow[];
}

export function getTold(): Told {
  return { pinned: state.pinned, rules: state.rules, customRows: state.customRows };
}

/** Union of this device's and another device's rows, interests and rules (removals don't sync). */
export function mergeTold(other: Told): Told {
  const lower = (x: string) => x.trim().toLowerCase();
  const union = (a: string[], b: string[]) => [...a, ...b.filter((x) => !a.some((y) => lower(y) === lower(x)))];
  const rows = [...state.customRows];
  for (const r of other.customRows ?? []) if (!rows.some((x) => lower(x.title) === lower(r.title))) rows.push(r);
  const before = JSON.stringify(getTold());
  state.pinned = union(state.pinned, other.pinned ?? []);
  state.rules = union(state.rules, other.rules ?? []);
  state.customRows = rows.slice(-4);
  void before;
  persist();
  return getTold();
}

// ---------------------------------------------------------------- profiles

export function currentProfile(): WanderProfile {
  return activeProfile();
}

/** Switch to another profile: save this one's data, load theirs, and show their set. */
export function switchProfile(id: string) {
  if (id === activeProfile().id) return;
  persist();
  setActiveProfileId(id);
  generation += 1;
  state = loadState();
  // Anything in flight belonged to the old profile; let new work start straight away.
  building = null;
  refilling = null;
  tasteRun = null;
  emitFeedChanged();
}

/** Delete a profile and what it learned (switching away first if it's the active one). */
export function removeProfile(id: string, fallbackId: string) {
  if (id === activeProfile().id) switchProfile(fallbackId);
  deleteProfile(id);
}

// ---------------------------------------------------------------- profile reports

export interface ProfileReport {
  profile: WanderProfile;
  /** What they're into right now, strongest first. */
  into: string[];
  /** Things that haven't landed lately. */
  notLanding: string[];
  taste: TasteProfile | null;
  told: Told;
  recent: { title: string; channel: string; at: number; fraction: number }[];
  watchedTotal: number;
  minutesThisWeek: number;
  videosThisWeek: number;
  pool: { total: number; fresh: number; described: number } | null;
  /** Today's TV time, for profiles with the timer on. */
  time: TimeStatus | null;
}

/** A profile's saved data: the live state for the active profile, a read-only copy for others. */
function stateFor(id: string): State {
  if (id === activeProfile().id) return state;
  return { ...fresh(), ...load<Partial<State>>(stateKey(id), {}) };
}

export function profileReport(id = activeProfile().id): ProfileReport {
  const s = stateFor(id);
  const now = Date.now();
  const ranked = rankTopics(Object.keys(s.conceptProfile).length >= 5 ? s.conceptProfile : s.profile, now);
  const week = s.history.filter((h) => now - h.at < 7 * DAY);
  const isActive = id === activeProfile().id;
  const h = isActive ? poolHealth(s.pool, ctx()) : null;
  return {
    profile: listProfiles().find((p) => p.id === id) ?? activeProfile(),
    into: ranked.filter((t) => t.score > 0.05).slice(0, 10).map((t) => t.name),
    notLanding: ranked.filter((t) => t.score < -0.05).slice(-5).reverse().map((t) => t.name),
    taste: s.taste,
    told: { pinned: s.pinned, rules: s.rules, customRows: s.customRows },
    recent: s.history.slice(-8).reverse().map((w) => ({ title: w.title, channel: w.channelTitle, at: w.at, fraction: w.fraction })),
    watchedTotal: s.history.length,
    minutesThisWeek: Math.round(week.reduce((a, w) => a + w.watchedSec, 0) / 60),
    videosThisWeek: week.length,
    pool: h ? { total: h.total, fresh: h.freshMain, described: h.described } : null,
    time: timeStatus(id).on ? timeStatus(id) : null,
  };
}

/** Add a standing instruction for Claude, or forget something, for any profile on this device. */
export function guideProfile(id: string, change: { addRule?: string; forget?: { kind: 'row' | 'interest' | 'rule'; value: string } }) {
  const isActive = id === activeProfile().id;
  const s = stateFor(id);
  const rule = change.addRule?.trim();
  if (rule && !s.rules.some((r) => r.toLowerCase() === rule.toLowerCase())) s.rules = [...s.rules, rule].slice(-20);
  const f = change.forget;
  if (f?.kind === 'row') s.customRows = s.customRows.filter((r) => r.id !== f.value);
  if (f?.kind === 'interest') s.pinned = s.pinned.filter((p) => p !== f.value);
  if (f?.kind === 'rule') s.rules = s.rules.filter((p) => p !== f.value);
  if (isActive) persist();
  else save(stateKey(id), s);
}

// ---------------------------------------------------------------- explore

export interface ExploreResult {
  /** What was asked or searched. */
  text: string;
  reply?: string;
  changes?: string[];
  /** Matches already in the pool (instant). */
  poolHits: Candidate[];
  /** Fresh results from YouTube. */
  results: Candidate[];
  /** Picks for a focus Claude chose. */
  focus: Candidate[];
  /** A new set is waiting on Home. */
  newSet?: boolean;
  notice?: string;
}

/** A plain search: what's in the pool now, then YouTube's results. */
export async function exploreSearch(keys: ApiKeys, q: string): Promise<ExploreResult> {
  const poolHits = searchPool(q);
  const results = await search(q, keys);
  const seen = new Set(results.map((r) => r.id));
  return { text: q, poolHits: poolHits.filter((p) => !seen.has(p.id)), results, focus: [] };
}

/** Anything typed or said in Explore: Claude decides whether it's a search or a change, and acts. */
export async function exploreAsk(keys: ApiKeys, text: string, onProgress: (msg: string) => void, browsing?: string[]): Promise<ExploreResult> {
  const t = text.trim();
  if (!claudeAuth(keys)) return exploreSearch(keys, t);
  const out = await ask(keys, t, onProgress, browsing);
  if (out.search) {
    onProgress(`Searching for “${out.search}”…`);
    return { ...(await exploreSearch(keys, out.search)), text: t, reply: out.reply };
  }
  const focus = out.feed?.rows.find((r) => r.id === 'focus')?.items ?? [];
  return { text: t, reply: out.reply, changes: out.changes, poolHits: [], results: [], focus, newSet: !!out.feed, notice: out.notice };
}

// ---------------------------------------------------------------- why lines

/** Ask Claude for a "why this for you" line for each video on screen that doesn't have one yet. */
async function explainFeed(auth: ClaudeAuth) {
  const feed = state.feed;
  if (!feed) return;
  const todo = feed.rows.flatMap((r) => r.items).filter((c) => !c.why).slice(0, 48);
  if (!todo.length) return;
  const gen = generation;
  const now = Date.now();
  const lines = await explainPicks(
    auth,
    {
      interests: rankTopics(Object.keys(state.conceptProfile).length >= 5 ? state.conceptProfile : state.profile, now)
        .filter((t) => t.score > 0.05)
        .slice(0, 12)
        .map((t) => t.name),
      tasteSummary: state.taste?.summary ?? '',
      recentTitles: state.history.slice(-8).map((h) => h.title),
    },
    todo,
  );
  if (gen !== generation || state.feed !== feed) return;
  const add = (c: Candidate) => (lines[c.id] ? { ...c, why: lines[c.id] } : c);
  state.feed = { ...feed, rows: feed.rows.map((r) => ({ ...r, items: r.items.map(add) })) };
  persist();
  emitFeedChanged();
}

// ---------------------------------------------------------------- Explore's map

/** Which place on the map a video was opened from, so watching it lights up that place. */
const openedFrom = new Map<string, string>();
export function noteOpenedFrom(videoId: string, path: string[]) {
  openedFrom.set(videoId, pathId(path));
}

export function visitPlace(path: string[]) {
  state.mapVisits[pathId(path)] = { path, at: Date.now() };
  persist();
}

/** The places opened most recently (deepest first when tied), for "Pick up where you were". */
export function recentPlaces(n = 4): string[][] {
  return Object.values(state.mapVisits)
    .filter((v) => v.path.length > 1)
    .sort((a, b) => b.at - a.at)
    .slice(0, n)
    .map((v) => v.path);
}

export type PlaceMark = 'love' | 'watched' | 'none';

/** How a place is marked: videos watched from it or anywhere inside it. */
export function placeMark(path: string[]): PlaceMark {
  const id = pathId(path);
  let n = 0;
  for (const [k, v] of Object.entries(state.mapWatch)) if (k === id || k.startsWith(id + ' › ')) n += v;
  return n >= 3 ? 'love' : n >= 1 ? 'watched' : 'none';
}

/** How many places inside an area have been opened. */
export function placesVisitedIn(path: string[]): number {
  const id = pathId(path);
  return Object.keys(state.mapVisits).filter((k) => k.startsWith(id + ' › ')).length;
}

export interface PlaceVideos {
  videos: Candidate[];
  /** Set when these came from the pool instead of a fresh search (e.g. the daily limit is used up). */
  note?: string;
}

const PLACE_CACHE = 7 * DAY;
const PLACES_KEPT = 40;

/** A place's videos: one YouTube search for that place (kept for a week), filtered and ordered for this profile. */
export async function placeVideos(keys: ApiKeys, place: MapPlace, onProgress: (m: string) => void = () => undefined): Promise<PlaceVideos> {
  const id = pathId(place.path);
  const show = (list: Candidate[]) => {
    const c = ctx();
    const score = makeScorer({ ...c, rng: () => 0.5 });
    // Keep YouTube's relevance order mostly, nudged by quality and this profile's leanings.
    return list
      .filter((v) => eligible(v, c))
      .map((v, i) => ({ v, s: score(v) / (1 + i * 0.08) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 18)
      .map((x) => x.v);
  };
  const cached = state.mapVideos[id];
  if (cached?.videos && Date.now() - cached.at < PLACE_CACHE) return { videos: show(cached.videos) };

  if (quotaUsed() + 101 > AUTO_BUDGET) {
    const fromPool = matchPool(state.pool, ctx(), `${place.name} ${place.desc}`, place.concepts, 18).filter((v) => v.tier !== 'shorts');
    return { videos: fromPool, note: 'YouTube’s daily limit is used up, so these are from videos you already have. Fresh ones tomorrow.' };
  }

  onProgress('Searching YouTube for this place…');
  const now = Date.now();
  const gen = generation;
  const ids = await searchIds(place.query, keys.youtube, { maxResults: 30, language: getSettings().language });
  const details = await videoDetails(ids, keys.youtube);
  const found: Candidate[] = details.map((v) => ({
    ...v,
    topic: place.name,
    tier: 'search' as const,
    because: `On the map: ${place.path.join(' › ')}`,
    query: place.query,
    fetchedAt: now,
  }));
  // Claude describes them (and checks them for kid profiles) before they're shown.
  await describe(found, claudeAuth(keys), () => undefined, found.length);
  if (gen !== generation) return { videos: [] };
  mergePool(found);
  // Kept without descriptions, to stay small.
  state.mapVideos[id] = { at: now, videos: found.map((v) => ({ ...v, description: undefined })) };
  const keys_ = Object.keys(state.mapVideos);
  if (keys_.length > PLACES_KEPT) {
    for (const k of keys_.sort((a, b) => state.mapVideos[a].at - state.mapVideos[b].at).slice(0, keys_.length - PLACES_KEPT)) delete state.mapVideos[k];
  }
  persist();
  return { videos: show(found) };
}

// ---------------------------------------------------------------- channels you like

/** Channels whose videos this profile watches to the end, most first. */
export function favouriteChannels(limit = 6): { id: string; title: string }[] {
  const now = Date.now();
  const counts = new Map<string, { id: string; title: string; n: number }>();
  for (const h of state.history) {
    if (h.fraction < 0.6 || now - h.at > 90 * DAY || state.muted.includes(h.channelId)) continue;
    const c = counts.get(h.channelId) ?? { id: h.channelId, title: h.channelTitle, n: 0 };
    c.n += 1;
    counts.set(h.channelId, c);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, limit);
}

async function fromFavouriteChannels(keys: ApiKeys): Promise<Candidate[]> {
  const chans = favouriteChannels();
  if (!chans.length) return [];
  const now = Date.now();
  const videos = await channelUploads(chans.map((c) => c.id), keys.youtube);
  return videos.map((v) => ({
    ...v,
    topic: v.channelTitle,
    tier: 'channel' as const,
    because: `New from ${v.channelTitle}, which you watch to the end`,
    query: '',
    fetchedAt: now,
  }));
}
