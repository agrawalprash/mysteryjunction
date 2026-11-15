// Shared data shapes for the recommendation engine.

/** How far a recommendation is from what the viewer already likes. */
export type Tier = 'core' | 'adjacent' | 'wildcard' | 'archive' | 'shorts' | 'search' | 'focus' | 'custom';

export interface Video {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string; // ISO date
  durationSec: number;
  views: number;
  likes: number;
  comments: number;
  thumb: string;
  /** First part of the description, used when Claude describes the video. */
  description?: string;
}

export const FORMATS = [
  'documentary', 'lecture', 'explainer', 'process', 'performance', 'interview',
  'travel', 'essay', 'tutorial', 'commentary', 'compilation', 'vlog', 'other',
] as const;
export type Format = (typeof FORMATS)[number];

/** Claude's description of a video, used to learn taste beyond topic names. */
export interface Facets {
  subject: string;
  format: Format;
  pace: 'calm' | 'moderate' | 'energetic';
  depth: 'light' | 'medium' | 'deep';
  clickbait: boolean;
}

/** A video plus where it came from, so we can learn from what happens to it. */
export interface Candidate extends Video {
  topic: string;
  tier: Tier;
  because: string;
  query: string;
  fetchedAt: number;
  facets?: Facets;
  /** For tier 'custom': which of the viewer's own rows this belongs to. */
  rowId?: string;
}

/** One search direction proposed by the planner (Claude or the offline fallback). */
export interface Direction {
  topic: string;
  query: string;
  tier: Tier;
  because: string;
  rowId?: string;
  /** YouTube channel handles to read uploads from (cheap) before falling back to search. */
  channels?: string[];
}

/** A row the viewer asked for ("add a row for live jazz"). Appears in every set. */
export interface CustomRow {
  id: string;
  title: string;
  brief: string;
}

export interface TopicState {
  name: string;
  /** Fast-moving interest (half-life ~4 days): what you're into this week. */
  short: number;
  /** Slow-moving interest (half-life ~60 days): what you like in general. */
  long: number;
  updatedAt: number;
  /** Tier the topic was first discovered through. */
  origin: Tier;
  firstSeenAt: number;
  exposures: number;
  watches: number;
  /** Timestamps of recent watches, used for topic fatigue. */
  recentWatches: number[];
}

export interface WatchRecord {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  thumb: string;
  durationSec: number;
  topic: string;
  tier: Tier;
  watchedSec: number;
  fraction: number;
  at: number;
  facets?: Facets;
}

/** A video opened and abandoned within seconds. */
export interface ExitRecord {
  title: string;
  topic: string;
  facets?: Facets;
  at: number;
}

/** Claude's weekly written read of the viewer's taste. */
export interface TasteProfile {
  summary: string;
  loves: string[];
  avoid: string[];
  curiousAbout: string[];
  formatsLiked: string[];
  formatsDisliked: string[];
  generatedAt: number;
  watchesSeen: number;
}

export interface FeedRow {
  id: string;
  title: string;
  subtitle: string;
  items: Candidate[];
}

export interface DailyFeed {
  date: string; // YYYY-MM-DD, local time
  generatedAt: number;
  rows: FeedRow[];
  shorts: Candidate[];
  surprisesUsed: number;
  plannerNote: string;
  /** What this set centres on, if the viewer asked for something ("music"). */
  focus?: string;
}
