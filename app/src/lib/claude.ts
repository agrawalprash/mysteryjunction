// Asks Claude for today's search directions: what to look for on YouTube at
// three distances from the viewer's interests. One call per day (plus one per
// "Surprise me"), a few cents.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Direction } from '../engine/types.ts';

const MODEL = 'claude-opus-5-5';

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
  language: string;
}

const SYSTEM = `You plan a daily YouTube home feed for one person who is tired of seeing the same kind of video over and over. Your job is to choose search directions so that what they see is interesting, varied, and sometimes opens up a brand-new interest.

Principles:
- Curiosity peaks at moderate novelty: new, but connected to what the person already knows. Use three distances:
  - core: the person's existing interests, but approached from fresh angles, formats, creators, or eras (not the obvious query).
  - adjacent: stepping stones one hop away from an interest (woodworking -> Japanese joinery, Edo-period carpenters' guilds, how saws are sharpened). Each should make sense as "if you like X you might like this".
  - wildcard: genuinely unrelated, broadly fascinating subjects that a curious person would enjoy without prior knowledge. Avoid dry, jargon-heavy or niche-technical topics. Vary across science, history, craft, music, places, people, nature, ideas, sport, food, art.
- Vary formats on purpose: documentaries, lectures, craft process videos, travel, live music performances, interviews, essays, explainers.
- Vary geography and culture: not everything should be American or English-centric.
- Queries should find substantial, high-quality long-form videos. Write them the way a knowledgeable person would search (specific nouns, not clickbait phrasing). Do not put years or "documentary" in every query.
- Never repeat a topic from the "recently used topics" list. Avoid topics the person recently skipped.
- A topic someone watched a lot this week is in fatigue: treat it lightly in core, prefer its neighbours.
- archive: classic older videos (the app restricts these searches to before ~2016), e.g. old lectures, early YouTube craft channels, vintage TV segments.
- shorts: light, delightful topics that work in under a minute.
- "because" is shown to the viewer. Keep it under 8 words, warm and specific.`;

function describe(input: PlannerInput): string {
  const lines: string[] = [];
  if (input.interests.length === 0) {
    lines.push('This is a new viewer: nothing is known yet. Make "core" a broad sampler across very different fields (one item per field) so their tastes can be learned quickly.');
  } else {
    lines.push('Current interests (score: higher means stronger):');
    for (const i of input.interests) lines.push(`- ${i.name} (${i.score.toFixed(2)})`);
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

function client(apiKey: string) {
  // The key stays on the device; requests go straight from the phone to Anthropic.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

function toDirections(items: z.infer<typeof Item>[], tier: Direction['tier'], max: number): Direction[] {
  return items
    .filter((i) => i.topic.trim() && i.query.trim())
    .slice(0, max)
    .map((i) => ({ topic: i.topic.trim(), query: i.query.trim(), because: i.because.trim(), tier }));
}

export async function planDay(apiKey: string, input: PlannerInput): Promise<{ directions: Direction[]; note: string }> {
  const res = await client(apiKey).beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(Plan) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `${describe(input)}\n\nPlan today's feed: exactly 5 core, 5 adjacent, 5 wildcard, 2 archive and 4 shorts directions.`,
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

export async function planSurprise(apiKey: string, input: PlannerInput): Promise<Direction[]> {
  const res = await client(apiKey).beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(Surprise) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `${describe(input)}\n\nThe viewer tapped "Surprise me". Give exactly 3 wildcard directions that are far from everything above and from each other.`,
      },
    ],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('Planner returned no plan');
  return toDirections(res.parsed_output.wildcard, 'wildcard', 3);
}

/** Cheap check that the key works (no tokens spent). */
export async function testKey(apiKey: string): Promise<void> {
  await client(apiKey).models.retrieve(MODEL);
}
