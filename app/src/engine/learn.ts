// Learning pieces that run on the device in milliseconds:
//  - concept taste: Claude tags each video with concepts; your taste is a weighted set of them
//  - a tiny ranking model (online logistic regression) that learns what you finish
//  - Thompson sampling, so exploring uncertain topics is a deliberate bet, not noise

import type { Candidate, Video } from './types.ts';
import { addSignal, interest, type Profile } from './profile.ts';

// ---------------------------------------------------------------- concepts

export function normConcept(c: string): string {
  return c.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function conceptsOf(c: { facets?: { concepts?: string[] } }): string[] {
  return [...new Set((c.facets?.concepts ?? []).map(normConcept).filter(Boolean))];
}

/** Spread a watch signal over the video's concepts (each gets a share). */
export function addConceptSignal(profile: Profile, concepts: string[], amount: number, now: number): Profile {
  if (concepts.length === 0) return profile;
  const share = amount / Math.sqrt(concepts.length);
  let p = profile;
  for (const c of concepts) p = addSignal(p, c, share, now);
  return p;
}

/** How well a video's concepts match your taste; roughly -1…+2, 0 when unknown. */
export function conceptAffinity(profile: Profile, concepts: string[], now: number): number {
  if (concepts.length === 0) return 0;
  let sum = 0;
  for (const c of concepts) {
    const t = profile[c];
    if (t) sum += interest(t, now);
  }
  return sum / Math.sqrt(concepts.length);
}

/** The concepts you like most, for Claude to keep its vocabulary consistent. */
export function topConcepts(profile: Profile, now: number, n = 60): string[] {
  return Object.entries(profile)
    .map(([k, t]) => [k, interest(t, now)] as const)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, n)
    .map(([k]) => k);
}

// ---------------------------------------------------------------- ranking model

export const FEATURES = [
  'bias', 'core', 'adjacent', 'wildcard', 'archive', 'focus', 'custom',
  'documentary', 'lecture', 'explainer', 'process', 'performance', 'interview', 'travel', 'essay', 'tutorial', 'commentary',
  'calm', 'energetic', 'deep', 'light', 'clickbait',
  'logMinutes', 'logViews', 'likeRatio', 'ageYears', 'affinity',
] as const;

export type Weights = number[];

export function initialWeights(): Weights {
  return FEATURES.map((f) => (f === 'affinity' ? 0.8 : f === 'likeRatio' ? 0.6 : f === 'clickbait' ? -0.6 : 0));
}

export function features(c: Candidate, affinity: number, now = Date.now()): number[] {
  const f = c.facets;
  const v = c as Video;
  const minutes = Math.max(1, v.durationSec / 60);
  const ageYears = v.publishedAt ? Math.max(0, (now - new Date(v.publishedAt).getTime()) / (365 * 86_400_000)) : 2;
  const map: Record<string, number> = {
    bias: 1,
    [c.tier]: 1,
    ...(f ? { [f.format]: 1, [f.pace]: 1, [f.depth]: 1, clickbait: f.clickbait ? 1 : 0 } : {}),
    logMinutes: Math.log(minutes) / 3,
    logViews: Math.log10(Math.max(10, v.views)) / 6,
    likeRatio: Math.min(v.views > 0 ? v.likes / v.views : 0, 0.1) * 10,
    ageYears: Math.min(ageYears, 20) / 10,
    affinity: Math.max(-2, Math.min(2, affinity)),
  };
  return FEATURES.map((name) => map[name] ?? 0);
}

export function predict(w: Weights, x: number[]): number {
  let z = 0;
  for (let i = 0; i < x.length; i++) z += (w[i] ?? 0) * x[i];
  return 1 / (1 + Math.exp(-z));
}

/** One step of online learning: y=1 finished/liked, y=0 skipped. `weight` < 1 for weak signals. */
export function update(w: Weights, x: number[], y: 0 | 1, weight = 1, lr = 0.08, l2 = 0.002): Weights {
  const p = predict(w, x);
  const g = (y - p) * weight;
  return w.map((wi, i) => wi + lr * (g * x[i] - l2 * wi));
}

// ---------------------------------------------------------------- exploration

function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(k, 1) sample (Marsaglia–Tsang; k ≥ 1 here). */
function gamma(k: number, rng: () => number): number {
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let tries = 0; tries < 30; tries++) {
    const x = gaussian(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    if (Math.log(rng()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
  return k; // the mean; only reached with a degenerate random source
}

/** Thompson sample of a topic's "lands with you" rate from its wins and tries. */
export function sampleRate(wins: number, tries: number, rng: () => number = Math.random): number {
  const a = 1 + Math.max(0, wins);
  const b = 1 + Math.max(0, tries - wins);
  const x = gamma(a, rng);
  const y = gamma(b, rng);
  return x / (x + y);
}
