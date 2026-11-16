// Explore's "worlds": groups of videos in the pool around one of Claude's concept tags.
// Nothing is hardcoded: worlds come from what's in the pool and what the profile has watched.
//   yours: concepts the profile has shown a liking for, with videos waiting in the pool
//   edges: concepts it hasn't explored yet that keep turning up next to "yours"

import type { Candidate } from './types.ts';
import { conceptAffinity, conceptsOf, normConcept } from './learn.ts';
import type { Profile } from './profile.ts';

export interface World {
  /** The concept tag, lower case. */
  concept: string;
  /** Videos for it in the pool that could be shown. */
  count: number;
  /** How much this profile likes it (0 for edges). */
  affinity: number;
  /** For an edge: the world of yours it most often appears next to. */
  via?: string;
}

export interface Worlds {
  yours: World[];
  edges: World[];
}

const MIN_VIDEOS = 3;

export function computeWorlds(videos: Candidate[], conceptProfile: Profile, now: number, maxYours = 10, maxEdges = 8): Worlds {
  const count = new Map<string, number>();
  for (const v of videos) for (const c of new Set(conceptsOf(v))) count.set(c, (count.get(c) ?? 0) + 1);
  const big = [...count.entries()].filter(([, n]) => n >= MIN_VIDEOS);

  const liked = big
    .map(([concept, n]) => ({ concept, count: n, affinity: conceptAffinity(conceptProfile, [concept], now) }))
    .filter((w) => w.affinity > 0.05)
    .sort((a, b) => b.affinity - a.affinity);

  // A new profile has no likings yet: show the biggest worlds in the pool instead.
  const yours = (liked.length ? liked : big.map(([concept, n]) => ({ concept, count: n, affinity: 0 })).sort((a, b) => b.count - a.count)).slice(
    0,
    maxYours,
  );
  const mine = new Set(yours.map((w) => w.concept));

  // Edges: unexplored concepts that share videos with your worlds.
  const together = new Map<string, Map<string, number>>();
  for (const v of videos) {
    const cs = [...new Set(conceptsOf(v))];
    const ownHere = cs.filter((c) => mine.has(c));
    if (!ownHere.length) continue;
    for (const c of cs) {
      if (mine.has(c)) continue;
      const m = together.get(c) ?? new Map<string, number>();
      for (const o of ownHere) m.set(o, (m.get(o) ?? 0) + 1);
      together.set(c, m);
    }
  }
  const edges = big
    .filter(([c]) => !mine.has(c) && conceptAffinity(conceptProfile, [c], now) <= 0.05 && together.has(c))
    .map(([concept, n]) => {
      const links = [...together.get(concept)!.entries()].sort((a, b) => b[1] - a[1]);
      const shared = links.reduce((a, [, k]) => a + k, 0);
      return { concept, count: n, affinity: 0, via: links[0][0], shared };
    })
    .sort((a, b) => b.shared - a.shared || b.count - a.count)
    .slice(0, maxEdges)
    .map(({ shared: _shared, ...w }) => w);

  return { yours, edges };
}

/** The pool's videos for one world, best first. */
export function worldVideos(videos: Candidate[], concept: string, score: (c: Candidate) => number, limit = 24): Candidate[] {
  const want = normConcept(concept);
  return videos
    .filter((v) => conceptsOf(v).includes(want))
    .map((v) => ({ v, s: score(v) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.v);
}
