// The interest model: learns from what the viewer does, with no explicit input.
// Pure functions over plain data so the logic is easy to test and tune.

import type { Tier, TopicState, WatchRecord } from './types.ts';

const DAY = 24 * 60 * 60 * 1000;
export const SHORT_HALF_LIFE = 4 * DAY;
export const LONG_HALF_LIFE = 60 * DAY;
/** Watches of a topic inside this window make it temporarily less likely. */
export const FATIGUE_WINDOW = 3 * DAY;

export type Profile = Record<string, TopicState>;

export function normalizeTopic(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function decay(value: number, elapsed: number, halfLife: number): number {
  if (elapsed <= 0) return value;
  return value * Math.pow(0.5, elapsed / halfLife);
}

/** Returns the topic's values decayed to `now` (does not mutate). */
export function decayed(t: TopicState, now: number): TopicState {
  const elapsed = now - t.updatedAt;
  return {
    ...t,
    short: decay(t.short, elapsed, SHORT_HALF_LIFE),
    long: decay(t.long, elapsed, LONG_HALF_LIFE),
    updatedAt: now,
    recentWatches: t.recentWatches.filter((ts) => now - ts < FATIGUE_WINDOW),
  };
}

/** Add a signal (positive or negative) to a topic. Returns a new profile. */
export function addSignal(
  profile: Profile,
  topicName: string,
  amount: number,
  now: number,
  origin: Tier = 'core',
  opts: { watched?: boolean; exposed?: boolean } = {},
): Profile {
  const key = normalizeTopic(topicName);
  if (!key) return profile;
  const existing: TopicState = profile[key] ?? {
    name: topicName.trim(),
    short: 0,
    long: 0,
    updatedAt: now,
    origin,
    firstSeenAt: now,
    exposures: 0,
    watches: 0,
    recentWatches: [],
  };
  const t = decayed(existing, now);
  t.short += amount;
  // Long-term memory moves more slowly and is harder to push negative.
  t.long += amount > 0 ? amount * 0.5 : amount * 0.2;
  if (opts.exposed) t.exposures += 1;
  if (opts.watched) {
    t.watches += 1;
    t.recentWatches = [...t.recentWatches, now];
  }
  return { ...profile, [key]: t };
}

/** How much the viewer currently likes a topic, before fatigue. */
export function interest(t: TopicState, now: number): number {
  const d = decayed(t, now);
  return 0.6 * d.short + 0.4 * d.long;
}

/** 1.0 = fresh; drops toward ~0.3 if the topic was watched a lot in the last few days. */
export function freshness(t: TopicState, now: number): number {
  const d = decayed(t, now);
  return Math.max(0.3, Math.exp(-0.25 * d.recentWatches.length));
}

/** Translate how a watch went into a learning signal. No input needed from the viewer. */
export function watchSignal(watchedSec: number, durationSec: number): number {
  const fraction = durationSec > 0 ? watchedSec / durationSec : 0;
  if (fraction >= 0.7) return 1.0;
  if (fraction >= 0.3) return 0.5;
  if (watchedSec < 20) return -0.4; // opened, didn't hook them
  return 0.1;
}

/** Impression without a tap: a very weak "not this". */
export const IGNORED_SIGNAL = -0.05;
export const SEARCH_SIGNAL = 0.6;
export const LESS_LIKE_THIS_SIGNAL = -1.2;

export interface RankedTopic {
  name: string;
  score: number;
  freshness: number;
  origin: Tier;
  watches: number;
  exposures: number;
}

export function rankTopics(profile: Profile, now: number): RankedTopic[] {
  return Object.values(profile)
    .map((t) => ({
      name: t.name,
      score: interest(t, now),
      freshness: freshness(t, now),
      origin: t.origin,
      watches: t.watches,
      exposures: t.exposures,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Topics that count as "your interests". A wildcard or adjacent topic that
 * keeps landing graduates into this list; that is how new interests form.
 */
export function coreInterests(profile: Profile, now: number, limit = 12): RankedTopic[] {
  return rankTopics(profile, now)
    .filter((t) => t.score >= 0.35)
    .slice(0, limit);
}

/** Topics that were tried recently and did not land. */
export function recentMisses(profile: Profile, now: number, limit = 10): RankedTopic[] {
  return rankTopics(profile, now)
    .filter((t) => t.score < -0.1)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
}

/** Records eligible for the "Watch again" row: finished, and not too recent. */
export function watchAgainCandidates(history: WatchRecord[], now: number): WatchRecord[] {
  const seen = new Set<string>();
  return history
    .filter((w) => w.fraction >= 0.7 && now - w.at > 5 * DAY)
    .sort((a, b) => b.at - a.at)
    .filter((w) => (seen.has(w.videoId) ? false : (seen.add(w.videoId), true)));
}
