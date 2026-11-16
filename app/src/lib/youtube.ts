// Thin client for the YouTube Data API v3 with a local quota meter.
// Free quota is 10,000 units/day: a search costs 100, a videos lookup costs 1.

import type { Candidate, Direction, Video } from '../engine/types.ts';
import { load, localDate, save } from './store.ts';
import { activeProfile } from './profiles.ts';

const API = 'https://www.googleapis.com/youtube/v3';
export const DAILY_QUOTA = 10_000;
/** Stop spending on automatic searches past this point so manual search keeps working. */
export const AUTO_BUDGET = 9_200;
/** Roughly what one full set costs in YouTube quota (searches + lookups). */
export const SET_COST = 1_200;

interface QuotaState {
  date: string;
  used: number;
}

/** Quota units spent on YouTube calls so far today (tracked locally). */
export function quotaUsed(): number {
  const q = load<QuotaState>('quota', { date: localDate(), used: 0 });
  return q.date === localDate() ? q.used : 0;
}

function spend(units: number) {
  save('quota', { date: localDate(), used: quotaUsed() + units });
}

export class YouTubeError extends Error {
  status: number;
  reason: string;
  constructor(message: string, status: number, reason: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function call(path: string, params: Record<string, string | number | boolean | undefined>, key: string, cost: number) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  url.searchParams.set('key', key);
  spend(cost);
  const res = await fetch(url.toString());
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body?.error;
    throw new YouTubeError(err?.message ?? `YouTube API error ${res.status}`, res.status, err?.errors?.[0]?.reason ?? '');
  }
  return body;
}

export function parseDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? '');
  if (!m) return 0;
  const [, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

export interface SearchOptions {
  duration?: 'any' | 'short' | 'medium' | 'long';
  publishedBefore?: string;
  publishedAfter?: string;
  order?: 'relevance' | 'viewCount' | 'rating' | 'date';
  maxResults?: number;
  language?: string;
  safeSearch?: 'moderate' | 'strict';
}

// ---------------------------------------------------------------- caches
// Searches are the expensive call (100 units). The same search within a few days
// is served from here; channel lookups (1 unit) are remembered too.

interface Cached<T> {
  at: number;
  value: T;
}
const SEARCH_TTL = 3 * 24 * 60 * 60 * 1000;
const UPLOADS_TTL = 24 * 60 * 60 * 1000;
const CHANNEL_TTL = 30 * 24 * 60 * 60 * 1000;

function cacheGet<T>(name: string, k: string, ttl: number): T | undefined {
  const all = load<Record<string, Cached<T>>>(name, {});
  const hit = all[k];
  return hit && Date.now() - hit.at < ttl ? hit.value : undefined;
}

function cachePut<T>(name: string, k: string, value: T, max = 300) {
  const all = load<Record<string, Cached<T>>>(name, {});
  all[k] = { at: Date.now(), value };
  const keys = Object.keys(all);
  if (keys.length > max) {
    keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - max).forEach((x) => delete all[x]);
  }
  save(name, all);
}

/** Search for video IDs (100 units, or free if the same search ran in the last few days). */
export async function searchIds(q: string, key: string, opts: SearchOptions = {}): Promise<string[]> {
  // Kid profiles search with YouTube's strict SafeSearch (and keep their own cache entries).
  if (activeProfile().options.strictSafeSearch) opts = { ...opts, safeSearch: 'strict' };
  const cacheKey = JSON.stringify([q.trim().toLowerCase(), opts]);
  const cached = cacheGet<string[]>('cache-search', cacheKey, SEARCH_TTL);
  if (cached) return cached;
  const ids = await searchIdsUncached(q, key, opts);
  cachePut('cache-search', cacheKey, ids);
  return ids;
}

async function searchIdsUncached(q: string, key: string, opts: SearchOptions): Promise<string[]> {
  const body = await call(
    'search',
    {
      part: 'snippet',
      type: 'video',
      q,
      // Same price for 50 results as for 5: take plenty, leftovers feed later sets.
      maxResults: opts.maxResults ?? 40,
      videoEmbeddable: 'true',
      safeSearch: opts.safeSearch ?? 'moderate',
      videoDuration: opts.duration ?? 'any',
      publishedBefore: opts.publishedBefore,
      publishedAfter: opts.publishedAfter,
      order: opts.order ?? 'relevance',
      relevanceLanguage: opts.language,
    },
    key,
    100,
  );
  return (body.items ?? []).map((it: { id: { videoId: string } }) => it.id.videoId).filter(Boolean);
}

/** Look up full details for up to 50 videos per call (1 unit per call). */
export async function videoDetails(ids: string[], key: string): Promise<Video[]> {
  const out: Video[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (chunk.length === 0) continue;
    const body = await call('videos', { part: 'snippet,contentDetails,statistics,status', id: chunk.join(','), maxResults: 50 }, key, 1);
    for (const it of body.items ?? []) {
      if (it.status?.embeddable === false) continue;
      if (it.snippet?.liveBroadcastContent && it.snippet.liveBroadcastContent !== 'none') continue;
      const th = it.snippet?.thumbnails ?? {};
      out.push({
        id: it.id,
        title: it.snippet?.title ?? '',
        channelId: it.snippet?.channelId ?? '',
        channelTitle: it.snippet?.channelTitle ?? '',
        publishedAt: it.snippet?.publishedAt ?? '',
        durationSec: parseDuration(it.contentDetails?.duration),
        views: Number(it.statistics?.viewCount ?? 0),
        likes: Number(it.statistics?.likeCount ?? 0),
        comments: Number(it.statistics?.commentCount ?? 0),
        thumb: (th.high ?? th.medium ?? th.default)?.url ?? `https://i.ytimg.com/vi/${it.id}/hqdefault.jpg`,
        description: (it.snippet?.description ?? '').slice(0, 300),
      });
    }
  }
  return out;
}

/** A channel's uploads playlist from its handle (1 unit, then cached for a month). */
async function uploadsPlaylist(handle: string, key: string): Promise<string | null> {
  const h = handle.trim().startsWith('@') ? handle.trim() : `@${handle.trim()}`;
  const cached = cacheGet<string | null>('cache-channel', h.toLowerCase(), CHANNEL_TTL);
  if (cached !== undefined) return cached;
  const body = await call('channels', { part: 'contentDetails', forHandle: h }, key, 1);
  const id: string | null = body.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
  cachePut('cache-channel', h.toLowerCase(), id, 500);
  return id;
}

/** Up to 50 recent uploads from a playlist (1 unit, cached for a day). */
async function recentUploads(playlistId: string, key: string): Promise<string[]> {
  const cached = cacheGet<string[]>('cache-uploads', playlistId, UPLOADS_TTL);
  if (cached) return cached;
  const body = await call('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50 }, key, 1);
  const ids: string[] = (body.items ?? []).map((i: { contentDetails?: { videoId?: string } }) => i.contentDetails?.videoId).filter(Boolean);
  cachePut('cache-uploads', playlistId, ids, 300);
  return ids;
}

function sample<T>(items: T[], n: number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Video IDs from the channels Claude named (a few units instead of a 100-unit search). */
async function idsFromChannels(handles: string[], key: string): Promise<string[]> {
  const ids: string[] = [];
  for (const h of handles.slice(0, 3)) {
    try {
      const playlist = await uploadsPlaylist(h, key);
      if (playlist) ids.push(...sample(await recentUploads(playlist, key), 10));
    } catch (e) {
      if (e instanceof YouTubeError && e.status === 403) throw e; // quota/key problems: stop
    }
  }
  return ids;
}

/** Run one planner direction: channels first (cheap), search to fill in; then details and provenance. */
export async function fetchDirection(d: Direction, key: string, language?: string): Promise<Candidate[]> {
  const opts: SearchOptions = { language };
  if (d.tier === 'shorts') {
    opts.duration = 'short';
  } else if (d.tier === 'archive') {
    // Somewhere between 2006 and 2015, so the archive row isn't always the same era.
    const year = 2007 + Math.floor(Math.random() * 9);
    opts.publishedBefore = `${year}-12-31T00:00:00Z`;
  } else {
    // Mostly long-form; occasionally anything, so 3–4 minute gems still show up.
    const r = Math.random();
    opts.duration = r < 0.45 ? 'medium' : r < 0.8 ? 'long' : 'any';
  }
  // Archive needs a date filter, which only search has.
  const ids = d.channels?.length && d.tier !== 'archive' ? await idsFromChannels(d.channels, key) : [];
  if (ids.length < 6) ids.push(...(await searchIds(d.query, key, opts)));
  const videos = await videoDetails([...new Set(ids)], key);
  const now = Date.now();
  return videos.map((v) => ({ ...v, topic: d.topic, tier: d.tier, because: d.because, query: d.query, fetchedAt: now, rowId: d.rowId }));
}

/** Cheap call (1 unit) to check a key works. */
export async function testKey(key: string): Promise<void> {
  await call('videos', { part: 'id', id: 'jNQXAC9IVRw' }, key, 1);
}
