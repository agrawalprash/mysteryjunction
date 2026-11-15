// Thin client for the YouTube Data API v3 with a local quota meter.
// Free quota is 10,000 units/day: a search costs 100, a videos lookup costs 1.

import type { Candidate, Direction, Video } from '../engine/types.ts';
import { load, localDate, save } from './store.ts';

const API = 'https://www.googleapis.com/youtube/v3';
export const DAILY_QUOTA = 10_000;
/** Stop spending on automatic searches past this point so manual search keeps working. */
export const AUTO_BUDGET = 7_500;

interface QuotaState {
  date: string;
  used: number;
}

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
}

/** Search for video IDs only (100 units). */
export async function searchIds(q: string, key: string, opts: SearchOptions = {}): Promise<string[]> {
  const body = await call(
    'search',
    {
      part: 'snippet',
      type: 'video',
      q,
      maxResults: opts.maxResults ?? 15,
      videoEmbeddable: 'true',
      safeSearch: 'moderate',
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
      });
    }
  }
  return out;
}

/** Run one planner direction: search, then attach details and provenance. */
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
  const ids = await searchIds(d.query, key, opts);
  const videos = await videoDetails(ids, key);
  const now = Date.now();
  return videos.map((v) => ({ ...v, topic: d.topic, tier: d.tier, because: d.because, query: d.query, fetchedAt: now }));
}

/** Cheap call (1 unit) to check a key works. */
export async function testKey(key: string): Promise<void> {
  await call('videos', { part: 'id', id: 'jNQXAC9IVRw' }, key, 1);
}
