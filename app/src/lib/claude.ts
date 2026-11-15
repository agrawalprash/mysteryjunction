// All Claude calls the app makes:
//  - planDay / planSurprise: which YouTube searches to run (daily, and per "Surprise me")
//  - describeVideos: subject / format / pace / depth / clickbait for each candidate (daily)
//  - writeTasteProfile: a written read of the viewer's taste from their history (weekly)

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { FORMATS, type Candidate, type Direction, type ExitRecord, type Facets, type TasteProfile, type WatchRecord } from '../engine/types.ts';

const MODEL = 'claude-opus-5-5';
// If a request is declined by a safety classifier, the API retries it on a suitable fallback model.
const FALLBACK: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: 'default' } = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
};

export interface ClaudeAuth {
  apiKey: string;
  /** Needed only for organization-level keys that aren't tied to one workspace. */
  workspaceId?: string;
}

function client(auth: ClaudeAuth) {
  // The key stays on the device; requests go straight from the device to Anthropic.
  return new Anthropic({
    apiKey: auth.apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: auth.workspaceId ? { 'anthropic-workspace-id': auth.workspaceId } : undefined,
  });
}

/** Cheap check that the key works (no tokens spent). */
export async function testKey(auth: ClaudeAuth): Promise<void> {
  await client(auth).models.retrieve(MODEL);
}

// ---------------------------------------------------------------- planning

const Item = z.object({
  topic: z.string().describe('Short topic name, 1–5 words. Reuse an existing interest name exactly when it is the same topic.'),
  query: z.string().describe('The YouTube search query to run.'),
  because: z.string().describe('Shown to the viewer under the video. Max 8 words, e.g. "Next door to woodworking".'),
});

const Plan = z.object({
  core: z.array(Item),
  adjacent: z.array(Item),
  wildcard: z.array(Item),
  archive: z.array(Item),
  shorts: z.array(Item),
  note: z.string().describe('One short sentence for the viewer about today’s mix.'),
});

const Surprise = z.object({ wildcard: z.array(Item) });

export interface PlannerInput {
  interests: { name: string; score: number }[];
  misses: string[];
  recentWatches: { title: string; topic: string; fraction: number }[];
  recentSearches: string[];
  recentTopics: string[];
  formatLeanings: { name: string; score: number }[];
  taste: TasteProfile | null;
  language: string;
}

const PLAN_SYSTEM = `You plan a daily YouTube home feed for one person who is tired of seeing the same kind of video over and over. Your job is to choose search directions so that what they see is interesting, varied, and sometimes opens up a brand-new interest.

Principles:
- Curiosity peaks at moderate novelty: new, but connected to what the person already knows. Use three distances:
  - core: the person's existing interests, but approached from fresh angles, formats, creators, or eras (not the obvious query).
  - adjacent: stepping stones one hop away from an interest (woodworking -> Japanese joinery, Edo-period carpenters' guilds, how saws are sharpened). Each should make sense as "if you like X you might like this".
  - wildcard: genuinely unrelated, broadly fascinating subjects that a curious person would enjoy without prior knowledge. Avoid dry, jargon-heavy or niche-technical topics. Vary across science, history, craft, music, places, people, nature, ideas, sport, food, art.
- Use the written taste profile when there is one: it describes what kind of videos land (formats, pace, depth), not only subjects. Write queries that tend to surface that kind of video, but keep some format variety.
- Vary formats on purpose: documentaries, lectures, craft process videos, travel, live music performances, interviews, essays, explainers.
- Vary geography and culture: not everything should be American or English-centric.
- Queries should find substantial, high-quality long-form videos. Write them the way a knowledgeable person would search (specific nouns, not clickbait phrasing). Do not put years or "documentary" in every query.
- Never repeat a topic from the "recently used topics" list. Avoid topics the person recently skipped.
- A topic someone watched a lot this week is in fatigue: treat it lightly in core, prefer its neighbours.
- archive: classic older videos (the app restricts these searches to before ~2016), e.g. old lectures, early YouTube craft channels, vintage TV segments.
- shorts: light, delightful topics that work in under a minute.
- "because" is shown to the viewer. Keep it under 8 words, warm and specific.
- Write every query, topic and "because" in the viewer's language.`;

function describeViewer(input: PlannerInput): string {
  const lines: string[] = [];
  if (input.taste) {
    const t = input.taste;
    lines.push('Written taste profile (from their full history):', t.summary);
    if (t.loves.length) lines.push(`Loves: ${t.loves.join('; ')}`);
    if (t.avoid.length) lines.push(`Tends to avoid: ${t.avoid.join('; ')}`);
    if (t.curiousAbout.length) lines.push(`Recently curious about: ${t.curiousAbout.join('; ')}`);
    if (t.formatsLiked.length) lines.push(`Formats that land: ${t.formatsLiked.join('; ')}`);
    if (t.formatsDisliked.length) lines.push(`Formats that don't: ${t.formatsDisliked.join('; ')}`);
    lines.push('');
  }
  if (input.interests.length === 0) {
    lines.push('This is a new viewer: nothing is known yet. Make "core" a broad sampler across very different fields (one item per field) so their tastes can be learned quickly.');
  } else {
    lines.push('Current interests (score: higher means stronger):');
    for (const i of input.interests) lines.push(`- ${i.name} (${i.score.toFixed(2)})`);
  }
  if (input.formatLeanings.length) {
    lines.push('', `Learned leanings on format/pace/depth (positive = likes): ${input.formatLeanings.map((f) => `${f.name} ${f.score.toFixed(2)}`).join('; ')}`);
  }
  if (input.recentWatches.length) {
    lines.push('', 'Recently watched (fraction of the video watched):');
    for (const w of input.recentWatches) lines.push(`- "${w.title}" [topic: ${w.topic}] ${Math.round(w.fraction * 100)}%`);
  }
  if (input.misses.length) lines.push('', `Recently skipped topics: ${input.misses.join('; ')}`);
  if (input.recentSearches.length) lines.push('', `Recent searches: ${input.recentSearches.join('; ')}`);
  if (input.recentTopics.length) lines.push('', `Recently used topics (do not repeat): ${input.recentTopics.join('; ')}`);
  lines.push('', `Viewer language: ${input.language}`);
  return lines.join('\n');
}

function toDirections(items: z.infer<typeof Item>[], tier: Direction['tier'], max: number): Direction[] {
  return items
    .filter((i) => i.topic.trim() && i.query.trim())
    .slice(0, max)
    .map((i) => ({ topic: i.topic.trim(), query: i.query.trim(), because: i.because.trim(), tier }));
}

export async function planDay(auth: ClaudeAuth, input: PlannerInput): Promise<{ directions: Direction[]; note: string }> {
  const res = await client(auth).beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(Plan) },
    system: PLAN_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `${describeViewer(input)}\n\nPlan today's feed: exactly 5 core, 5 adjacent, 5 wildcard, 2 archive and 4 shorts directions.`,
      },
    ],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('Planner returned no plan');
  const p = res.parsed_output;
  return {
    directions: [
      ...toDirections(p.core, 'core', 6),
      ...toDirections(p.adjacent, 'adjacent', 6),
      ...toDirections(p.wildcard, 'wildcard', 6),
      ...toDirections(p.archive, 'archive', 3),
      ...toDirections(p.shorts, 'shorts', 4),
    ],
    note: p.note,
  };
}

export async function planSurprise(auth: ClaudeAuth, input: PlannerInput): Promise<Direction[]> {
  const res = await client(auth).beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(Surprise) },
    system: PLAN_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `${describeViewer(input)}\n\nThe viewer tapped "Surprise me". Give exactly 3 wildcard directions that are far from everything above and from each other.`,
      },
    ],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('Planner returned no plan');
  return toDirections(res.parsed_output.wildcard, 'wildcard', 3);
}

// ---------------------------------------------------------------- describing videos

const Tag = z.object({
  i: z.number().describe('The index of the video in the list.'),
  subject: z.string().describe('What it is about, 2–5 words, more specific than the search topic.'),
  format: z.enum(FORMATS),
  pace: z.enum(['calm', 'moderate', 'energetic']),
  depth: z.enum(['light', 'medium', 'deep']),
  clickbait: z.boolean().describe('True if the title/description look sensational, misleading or low-effort.'),
});
const Tags = z.object({ tags: z.array(Tag) });

const TAG_SYSTEM = `You label YouTube videos from their metadata so a recommendation app can learn what kinds of videos a person enjoys.
For each video give: subject; format (documentary = produced long-form film/report; lecture = talk or class; explainer = presenter explains a concept; process = watching something being made, repaired or done, little talking; performance = music, dance, comedy, sport; interview = conversation or podcast; travel = places and journeys; essay = opinionated video essay; tutorial = teaches a skill step by step; commentary = news, reactions, opinions on current things; compilation = lists, top-10s, clips; vlog = personal day-in-the-life; other); pace; depth; and whether it looks like clickbait.
Judge from title, channel, length and description. Label every video exactly once, using its index.`;

const TAG_BATCH = 40;

/** Describe videos in parallel batches. Returns facets by video id; missing entries just stay unlabelled. */
export async function describeVideos(auth: ClaudeAuth, videos: Candidate[]): Promise<Record<string, Facets>> {
  const out: Record<string, Facets> = {};
  const batches: Candidate[][] = [];
  for (let i = 0; i < videos.length; i += TAG_BATCH) batches.push(videos.slice(i, i + TAG_BATCH));
  await Promise.all(
    batches.map(async (batch) => {
      const list = batch
        .map((v, i) => {
          const mins = Math.round(v.durationSec / 60);
          const desc = (v.description ?? '').replace(/\s+/g, ' ').slice(0, 220);
          return `${i}. "${v.title}" | channel: ${v.channelTitle} | ${mins} min | ${desc}`;
        })
        .join('\n');
      try {
        const res = await client(auth).beta.messages.parse({
          model: MODEL,
          max_tokens: 16000,
          ...FALLBACK,
          output_config: { effort: 'low', format: betaZodOutputFormat(Tags) },
          system: TAG_SYSTEM,
          messages: [{ role: 'user', content: `Label these ${batch.length} videos:\n${list}` }],
        });
        for (const t of res.parsed_output?.tags ?? []) {
          const v = batch[t.i];
          if (v) out[v.id] = { subject: t.subject, format: t.format, pace: t.pace, depth: t.depth, clickbait: t.clickbait };
        }
      } catch (e) {
        console.warn('Describing a batch failed', e);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- taste profile

const Taste = z.object({
  summary: z.string().describe('2–4 sentences, written to the viewer ("You…"), about what kinds of videos they enjoy and how their taste is moving.'),
  loves: z.array(z.string()).describe('Up to 6 specific subjects or kinds of video they reliably enjoy.'),
  avoid: z.array(z.string()).describe('Up to 5 things that reliably do not land.'),
  curious_about: z.array(z.string()).describe('Up to 5 newer threads of interest worth exploring further.'),
  formats_liked: z.array(z.string()).describe('Formats, paces or depths that land, e.g. "calm process videos", "deep lectures".'),
  formats_disliked: z.array(z.string()),
});

export interface TasteInput {
  watches: WatchRecord[];
  exits: ExitRecord[];
  searches: string[];
  dismissed: string[];
  previous: TasteProfile | null;
}

export async function writeTasteProfile(auth: ClaudeAuth, input: TasteInput): Promise<TasteProfile> {
  const fmt = (f?: Facets) => (f ? ` {${f.subject}; ${f.format}; ${f.pace}; ${f.depth}}` : '');
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const lines = [
    'Watch history, oldest first (percent watched; Claude-labelled facets where available):',
    ...input.watches.map((w) => `- ${day(w.at)} ${Math.round(w.fraction * 100)}% "${w.title}" [${w.topic}; ${w.tier}]${fmt(w.facets)}`),
    '',
    'Opened but abandoned within seconds:',
    ...input.exits.map((e) => `- ${day(e.at)} "${e.title}" [${e.topic}]${fmt(e.facets)}`),
    '',
    `Searches: ${input.searches.join('; ') || 'none'}`,
    `Marked "less like this": ${input.dismissed.join('; ') || 'none'}`,
  ];
  if (input.previous) lines.push('', `Previous profile (update it, don't just repeat it): ${input.previous.summary}`);
  const res = await client(auth).beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: 'medium', format: betaZodOutputFormat(Taste) },
    system:
      'You read one person’s YouTube viewing behaviour and describe their taste, so a recommendation app can plan varied, interesting feeds for them. Finishing a video is a strong signal; leaving within seconds is a mild negative. Look for patterns in format, pace and depth as well as subject. Be specific and concrete; avoid generic statements. Note interests that are emerging, not only established ones.',
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const t = res.parsed_output;
  if (res.stop_reason === 'refusal' || !t) throw new Error('No taste profile returned');
  return {
    summary: t.summary,
    loves: t.loves,
    avoid: t.avoid,
    curiousAbout: t.curious_about,
    formatsLiked: t.formats_liked,
    formatsDisliked: t.formats_disliked,
    generatedAt: Date.now(),
    watchesSeen: input.watches.length,
  };
}
