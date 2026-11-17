// All Claude calls the app makes:
//  - planDay / planSurprise: which YouTube searches to run (daily, and per "Surprise me")
//  - describeVideos: subject / format / pace / depth / clickbait for each candidate (daily)
//  - writeTasteProfile: a written read of the viewer's taste from their history (weekly)

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { FORMATS, type Candidate, type CustomRow, type Direction, type ExitRecord, type Facets, type TasteProfile, type WatchRecord } from '../engine/types.ts';

import { activeProfile } from './profiles.ts';

export const MODEL = 'claude-opus-5-5';
/** For quick list-making where speed matters more than judgement (drawing Explore's map). */
export const FAST_MODEL = 'claude-haiku-5-5';

/** Extra instructions for a profile with the playful (kid) option on. */
const PLAYFUL = `

THIS VIEWER IS A YOUNG CHILD (about 5–8 years old), watching with a grown-up's permission.
- Safety first: only choose directions and videos that are clearly made for or suitable for young children. No scary, violent, crude, romantic, prank, challenge or shock content, no unboxing/toy ads, no "kid influencer" channels, no clickbait. When unsure, leave it out.
- Be playful and creative: think like a great children's librarian or museum guide. Favour wonder, making things, animals, nature, how things work, stories, music and gentle humour.
- When the child asks for something specific (a game, a character, an animal), give them exactly that, within the safety rules; never swap it for something "better". Bridges come in addition, never instead.
- Follow what they love right now, whatever it is (a game, a character, an animal); never treat it as a problem. Build bridges out of it: real-world topics that start from that love (a building game → real caves, volcanoes, architecture; dinosaurs → fossils, birds).
- Prefer calmer, shorter videos (under about 15 minutes) when there's a choice, but don't drop a topic the child asked for just because most of its videos are lively.
- Anything you write that the child sees or hears (replies, row titles, reasons) uses short, simple, warm words a 6-year-old understands, with a sense of adventure.`;

/** A system prompt, adjusted for the active profile. */
export function forProfile(system: string): string {
  return activeProfile().options.playful ? system + PLAYFUL : system;
}
// If a request is declined by a safety classifier, the API retries it on a suitable fallback model.
export const FALLBACK: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: 'default' } = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
};

export interface ClaudeAuth {
  apiKey: string;
  /** Needed only for organization-level keys that aren't tied to one workspace. */
  workspaceId?: string;
}

export function client(auth: ClaudeAuth) {
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
  channels: z
    .array(z.string())
    .describe('1–3 YouTube channel handles (like "@SmarterEveryDay") that reliably make excellent videos for this direction. Only handles you are confident exist. Empty if unsure.'),
});

const Plan = z.object({
  focus: z.array(Item).describe('Directions for what the viewer asked for right now. Empty when there is no request.'),
  custom: z.array(z.object({ row: z.string().describe('The custom row title, exactly as given.'), items: z.array(Item) })),
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
  /** Long-term interests the viewer explicitly asked Wander to remember. */
  pinned: string[];
  /** Standing instructions, e.g. "no true crime". */
  rules: string[];
  customRows: CustomRow[];
  /** What the viewer asked for right now, e.g. "music". */
  focus: string;
  /** A small background top-up of the app's video pool rather than a whole set. */
  refill?: boolean;
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
- The viewer's own instructions win: always follow their standing rules, always cover some of their pinned long-term interests in core, and fill each of their custom rows with directions that fit its brief.
- When the viewer asked for something right now (focus), the focus directions are the heart of this set: still personalised to their taste, varied within the request, with one or two surprising takes. Other tiers stay as usual but may lean toward it where natural.
- Write every query, topic and "because" in the viewer's language.
- YouTube searches are expensive for the app (strict daily quota); reading a channel's uploads is nearly free. So for most directions also name 1–3 channels you are confident exist and that make great videos on that subject; favour lesser-known excellent channels over the biggest names, and vary them between directions. The app falls back to the search query if a channel isn't found. For wildcards, name channels only when you're sure; a search finds new creators better.`;

function describeViewer(input: PlannerInput): string {
  const lines: string[] = [];
  if (input.rules.length) lines.push(`Standing rules from the viewer (always follow): ${input.rules.join('; ')}`, '');
  if (input.pinned.length) lines.push(`Long-term interests the viewer asked you to remember: ${input.pinned.join('; ')}`, '');
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
  if (input.customRows.length) {
    lines.push('', 'The viewer\'s own rows (fill each one):');
    for (const r of input.customRows) lines.push(`- "${r.title}": ${r.brief}`);
  }
  if (input.focus) lines.push('', `The viewer asked for this right now: ${input.focus}`);
  lines.push('', `Viewer language: ${input.language}`);
  return lines.join('\n');
}

function toDirections(items: z.infer<typeof Item>[], tier: Direction['tier'], max: number): Direction[] {
  return items
    .filter((i) => i.topic.trim() && i.query.trim())
    .slice(0, max)
    .map((i) => ({
      topic: i.topic.trim(),
      query: i.query.trim(),
      because: i.because.trim(),
      tier,
      channels: (i.channels ?? []).map((c) => c.trim()).filter((c) => /^@?[\w.-]{3,}$/.test(c)).slice(0, 3),
    }));
}

/** How many searches of each kind one set uses (100 YouTube quota units each). */
export function planShape(input: Pick<PlannerInput, 'focus' | 'customRows' | 'refill'>) {
  if (input.refill) return { focus: 0, core: 3, adjacent: 3, wildcard: 3, archive: 1, shorts: 2, perCustomRow: 1 };
  return input.focus
    ? { focus: 5, core: 3, adjacent: 4, wildcard: 4, archive: 1, shorts: 3, perCustomRow: 2 }
    : { focus: 0, core: 5, adjacent: 5, wildcard: 5, archive: 2, shorts: 3, perCustomRow: 2 };
}

export async function planDay(auth: ClaudeAuth, input: PlannerInput): Promise<{ directions: Direction[]; note: string }> {
  const n = planShape(input);
  const ask = [
    n.focus ? `exactly ${n.focus} focus` : 'no focus (empty array)',
    `${n.core} core`,
    `${n.adjacent} adjacent`,
    `${n.wildcard} wildcard`,
    `${n.archive} archive`,
    `${n.shorts} shorts`,
    input.customRows.length ? `${n.perCustomRow} directions for each custom row` : 'no custom rows (empty array)',
  ].join(', ');
  const res = await client(auth).beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(Plan) },
    system: forProfile(PLAN_SYSTEM),
    messages: [
      {
        role: 'user',
        content: `${describeViewer(input)}\n\n${
          input.refill
            ? `This is a background top-up of the app's pool of candidate videos, steered by what the viewer watched most recently. Lean on channels (cheap) and avoid directions already covered recently. Plan: ${ask}.`
            : `Plan the next set: ${ask}.`
        }`,
      },
    ],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('Planner returned no plan');
  const p = res.parsed_output;
  return {
    directions: [
      ...toDirections(p.focus, 'focus', n.focus),
      ...input.customRows.flatMap((row) => {
        const match = p.custom.find((c) => c.row.trim().toLowerCase() === row.title.toLowerCase());
        return match ? toDirections(match.items, 'custom', n.perCustomRow).map((d) => ({ ...d, rowId: row.id })) : [];
      }),
      ...toDirections(p.core, 'core', n.core + 1),
      ...toDirections(p.adjacent, 'adjacent', n.adjacent + 1),
      ...toDirections(p.wildcard, 'wildcard', n.wildcard + 1),
      ...toDirections(p.archive, 'archive', n.archive),
      ...toDirections(p.shorts, 'shorts', n.shorts),
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
    system: forProfile(PLAN_SYSTEM),
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
  fits: z
    .number()
    .int()
    .min(0)
    .max(2)
    .describe('How well the video fits the "wanted" topic given for it: 2 clearly about it, 1 partly or loosely, 0 not about it.'),
  subject: z.string().describe('What it is about, 2–5 words, more specific than the search topic.'),
  format: z.enum(FORMATS),
  pace: z.enum(['calm', 'moderate', 'energetic']),
  depth: z.enum(['light', 'medium', 'deep']),
  clickbait: z.boolean().describe('True if the title/description look sensational, misleading or low-effort.'),
  kid_safe: z
    .boolean()
    .describe('True if a young child (about 5–8) could watch this alone: no violence or gore, horror or scares, crude or sexual content, bad language, dangerous pranks or challenges, shock or rage bait, toy ads or unboxing. Ordinary, clean gameplay, building, crafts, animals, science and fun are fine, including popular games like Minecraft. False if the title or channel suggests any of the excluded things.'),
  concepts: z
    .array(z.string())
    .describe('3–8 short lowercase concept tags (subject areas, places, crafts, eras, moods, e.g. "maritime history", "west africa", "slow craft"). Reuse tags from the given vocabulary when they fit.'),
});
const Tags = z.object({ tags: z.array(Tag) });

const TAG_SYSTEM = `You label YouTube videos from their metadata so a recommendation app can learn what kinds of videos a person enjoys.
For each video give: subject; format (documentary = produced long-form film/report; lecture = talk or class; explainer = presenter explains a concept; process = watching something being made, repaired or done, little talking; performance = music, dance, comedy, sport; interview = conversation or podcast; travel = places and journeys; essay = opinionated video essay; tutorial = teaches a skill step by step; commentary = news, reactions, opinions on current things; compilation = lists, top-10s, clips; vlog = personal day-in-the-life; other); pace; depth; and whether it looks like clickbait.
Judge from title, channel, length and description. Label every video exactly once, using its index.
Concepts are how the app relates videos to each other and to the viewer's taste, so make them meaningful and reusable: prefer an existing tag from the vocabulary over a near-synonym, mix broad tags ("history") with specific ones ("age of sail"), and include place/culture tags when relevant.`;

const TAG_BATCH = 40;

/** Describe videos in parallel batches. Returns facets by video id; missing entries just stay unlabelled. */
/** `batch`: videos per request; smaller batches run in parallel and finish sooner when someone is waiting. */
export async function describeVideos(auth: ClaudeAuth, videos: Candidate[], vocabulary: string[] = [], batch = TAG_BATCH): Promise<Record<string, Facets>> {
  const out: Record<string, Facets> = {};
  const batches: Candidate[][] = [];
  for (let i = 0; i < videos.length; i += batch) batches.push(videos.slice(i, i + batch));
  await Promise.all(
    batches.map(async (batch) => {
      const list = batch
        .map((v, i) => {
          const mins = Math.round(v.durationSec / 60);
          const desc = (v.description ?? '').replace(/\s+/g, ' ').slice(0, 220);
          return `${i}. "${v.title}" | channel: ${v.channelTitle} | ${mins} min | wanted: ${v.topic} | ${desc}`;
        })
        .join('\n');
      try {
        const res = await client(auth).beta.messages.parse({
          model: MODEL,
          max_tokens: 16000,
          ...FALLBACK,
          output_config: { effort: 'low', format: betaZodOutputFormat(Tags) },
          system: TAG_SYSTEM,
          messages: [
            {
              role: 'user',
              content: `${vocabulary.length ? `Concept vocabulary in use (reuse when it fits): ${vocabulary.join(', ')}\n\n` : ''}Label these ${batch.length} videos:\n${list}`,
            },
          ],
        });
        for (const t of res.parsed_output?.tags ?? []) {
          const v = batch[t.i];
          if (v)
            out[v.id] = {
              subject: t.subject,
              format: t.format,
              pace: t.pace,
              depth: t.depth,
              clickbait: t.clickbait,
              fits: Math.max(0, Math.min(2, Math.round(t.fits))) as 0 | 1 | 2,
              kidSafe: t.kid_safe,
              concepts: [...new Set(t.concepts.map((c) => c.trim().toLowerCase()).filter(Boolean))].slice(0, 8),
            };
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

// ---------------------------------------------------------------- talking to Wander

const Ask = z.object({
  reply: z.string().describe('1–2 short, warm sentences to the viewer saying what you are doing. No questions back.'),
  search: z
    .string()
    .describe('If the viewer simply wants to find specific videos (a title, person, channel, event or how-to), the YouTube search to run; otherwise empty. When set, leave new_set false and change nothing else.'),
  new_set: z.boolean().describe('Build a fresh set of videos now.'),
  focus: z.string().describe('What the new set should centre on (e.g. "music: live sessions and world music"). Empty if none.'),
  focus_concepts: z
    .array(z.string())
    .describe('For a focus: 3–10 lowercase concept tags a matching video would carry (e.g. "live music", "afrobeat", "jazz"), so the app can pick from videos it already has. Empty if no focus.'),
  add_rows: z.array(z.object({ title: z.string().describe('Short row title, 2–5 words.'), brief: z.string().describe('What belongs in the row, one sentence.') })),
  remove_rows: z.array(z.string()).describe('Titles of existing custom rows to remove.'),
  add_interests: z.array(z.string()).describe('Long-term interests to remember, short topic names.'),
  remove_interests: z.array(z.string()).describe('Remembered interests to forget, exactly as listed.'),
  add_rules: z.array(z.string()).describe('Standing instructions to remember, e.g. "No true crime".'),
  remove_rules: z.array(z.string()).describe('Standing rules to drop, exactly as listed.'),
});
export type AskResult = z.infer<typeof Ask>;

export interface AskContext {
  request: string;
  pinned: string[];
  rules: string[];
  customRows: CustomRow[];
  taste: TasteProfile | null;
  interests: string[];
  currentFocus: string;
  /** Where in Explore's map the viewer is, if anywhere ("History › Rome › Aqueducts"). */
  browsing?: string;
}

const ASK_SYSTEM = `You are the voice of Wander, a YouTube app that plans varied, interesting feeds for one person. The viewer just told you something, usually by voice (so expect transcription slips). Decide what to change:
- A mood or wish for now ("music today", "something funny", "short stuff please", "refresh", "show me something else") -> new_set true and a focus describing it (empty focus for a plain refresh).
- A lasting new category ("add a row for live jazz", "I want a cooking section") -> add_rows. Usually also new_set true so they can see it.
- A lasting interest ("remember I love maritime history", "I'm into F1 now") -> add_interests. A lasting dislike or instruction ("no more true crime", "fewer long videos") -> add_rules.
- Requests to stop something -> remove_rows / remove_interests / remove_rules using the exact existing names, or add a rule.
- Several of these can apply at once. If they only ask a question, answer briefly in reply and change nothing.
Keep their personal taste in mind: a focus like "music" should be personalised by what you know about them.`;

export async function askWander(auth: ClaudeAuth, ctx: AskContext): Promise<AskResult> {
  const lines = [
    `Viewer said: "${ctx.request}"`,
    '',
    `Custom rows: ${ctx.customRows.map((r) => `"${r.title}" (${r.brief})`).join('; ') || 'none'}`,
    `Remembered interests: ${ctx.pinned.join('; ') || 'none'}`,
    `Standing rules: ${ctx.rules.join('; ') || 'none'}`,
    `Learned interests: ${ctx.interests.join('; ') || 'none yet'}`,
    `Taste profile: ${ctx.taste?.summary ?? 'not written yet'}`,
    `Current set is centred on: ${ctx.currentFocus || 'nothing in particular'}`,
    ...(ctx.browsing
      ? [`The viewer is browsing this place on Explore's map: ${ctx.browsing}. Words like "this", "here" or "more like this" refer to it; a plain request is usually a search within it.`]
      : []),
  ];
  const res = await client(auth).beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(Ask) },
    system: forProfile(ASK_SYSTEM),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error(`Claude didn’t answer that one (${res.stop_reason ?? 'no answer'}). Try saying it differently.`);
  return res.parsed_output;
}

// ---------------------------------------------------------------- device diagnosis

const Diagnosis = z.object({
  summary: z.string().describe('One or two plain sentences: what is most likely wrong.'),
  findings: z.array(
    z.object({
      cause: z.string(),
      likelihood: z.enum(['high', 'medium', 'low', 'ruled out']),
      evidence: z.string().describe('Which facts in the report point to this (quote values).'),
    }),
  ),
  steps: z.array(z.string()).describe('What the viewer should try next, in order, as exact menu paths for this device. Short.'),
  needs_from_viewer: z.string().describe('Any test only the viewer can do, or empty.'),
});
export type DiagnosisResult = z.infer<typeof Diagnosis>;

export async function diagnoseDevice(auth: ClaudeAuth, report: unknown, symptoms: string): Promise<DiagnosisResult> {
  const res = await client(auth).beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: 'high', format: betaZodOutputFormat(Diagnosis) },
    system: `You are diagnosing an Android TV / Android device for its owner, from a read-only report the Wander app collected on the device, plus the owner's description of the problem.
Reason like a careful technician: separate what the report proves from what it only suggests, rule causes in or out with specific values from the report, and say plainly when something can't be determined from here.
Background you can rely on:
- Voice on Android TV: the remote's mic streams audio over Bluetooth only while the Assistant/mic button is held; the Google TV phone app sends audio to the TV's own voice service. If both fail the same way, the shared parts are the TV's voice/recognition service, its settings, the account/language, and the network path to Google.
- Android TV devices usually have no built-in mic, so an app-level speech test on a TV may fail with ERROR_AUDIO or similar even when the remote is fine; interpret that carefully.
- A host resolving to 0.0.0.0, 127.x, or a private address, or a DNS error for Google hosts, points to DNS filtering (Pi-hole, AdGuard, router parental controls).
- Common voice recogniser packages: com.google.android.katniss (Google app for Android TV), com.google.android.googlequicksearchbox, com.google.android.tts.
Write for a non-technical owner. Menu paths should match Android TV's English settings menus.`,
    messages: [
      {
        role: 'user',
        content: `What the owner says:\n${symptoms}\n\nDevice report (JSON):\n${JSON.stringify(report, null, 1)}`,
      },
    ],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('Claude couldn’t produce a diagnosis this time.');
  return res.parsed_output;
}

// ---------------------------------------------------------------- guidance ideas for a profile

const Guidance = z.object({
  ideas: z
    .array(
      z.object({
        instruction: z.string().describe('A standing instruction for Wander, written as the grown-up would say it, under 20 words.'),
        why: z.string().describe('One short sentence: what in the report suggests this.'),
      }),
    )
    .describe('4 to 6 ideas.'),
});
export type GuidanceIdea = z.infer<typeof Guidance>['ideas'][number];

export interface GuidanceInput {
  name: string;
  kid: boolean;
  into: string[];
  notLanding: string[];
  tasteSummary: string;
  recentTitles: string[];
  rules: string[];
  minutesThisWeek: number;
}

/** Suggest standing instructions a grown-up could give Wander for this profile. */
export async function suggestGuidance(auth: ClaudeAuth, input: GuidanceInput): Promise<GuidanceIdea[]> {
  const res = await client(auth).beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(Guidance) },
    system: `You help a grown-up steer Wander, a YouTube app that plans varied feeds, for one viewer. From a report of what the viewer watches, suggest standing instructions they could add. Instructions are followed every time Wander plans what to show.
Good ideas: build bridges out of what the viewer loves now into nearby real-world topics; widen variety where viewing is narrow; lean into formats that clearly land; gently counter anything that looks like a rut. Each idea must be concrete and specific to this report, never generic. Don't repeat instructions they already have.${
      input.kid
        ? '\nThis viewer is a young child (about 5–8). Ideas should help curiosity, creativity and calm, age-appropriate viewing, follow the child\'s current passions rather than fight them, and never use shame or bans.'
        : ''
    }`,
    messages: [
      {
        role: 'user',
        content: [
          `Viewer: ${input.name}${input.kid ? ' (a young child)' : ''}`,
          `Into right now: ${input.into.join(', ') || 'not known yet'}`,
          `Not landing: ${input.notLanding.join(', ') || 'nothing clear'}`,
          `Claude's read on their taste: ${input.tasteSummary || 'none yet'}`,
          `Recently watched: ${input.recentTitles.join(' | ') || 'nothing yet'}`,
          `Watched this week: ${input.minutesThisWeek} minutes`,
          `Instructions they already have: ${input.rules.join(' | ') || 'none'}`,
        ].join('\n'),
      },
    ],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('Claude had no ideas this time.');
  return res.parsed_output.ideas;
}

// ---------------------------------------------------------------- "why this for you" lines

const WhyLines = z.object({
  lines: z.array(z.object({ i: z.number().int(), why: z.string().describe('One sentence, at most 18 words.') })),
});

export interface WhyInput {
  interests: string[];
  tasteSummary: string;
  recentTitles: string[];
}

/** One line per video saying how it connects to this viewer, shown on cards (and read aloud if set). */
export async function explainPicks(auth: ClaudeAuth, viewer: WhyInput, videos: Candidate[]): Promise<Record<string, string>> {
  const res = await client(auth).beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(WhyLines) },
    system: forProfile(`You write the one-line "why this for you" shown under each video in a YouTube app. Each line connects the video to something specific this viewer likes, has watched, or is curious about, and makes the video sound worth a look. Be concrete ("You liked the Roman roads video: this is the same engineering problem, 1,500 years later"), never generic ("You might like this"). For a deliberate wildcard, say honestly that it's a step somewhere new and why it might click. No clickbait, no exclamation marks, no emoji.`),
    messages: [
      {
        role: 'user',
        content: [
          `Viewer's interests: ${viewer.interests.join(', ') || 'still being learned'}`,
          `Claude's read on them: ${viewer.tasteSummary || 'none yet'}`,
          `Recently watched: ${viewer.recentTitles.join(' | ') || 'nothing yet'}`,
          '',
          `Write a line for each of these ${videos.length} videos:`,
          ...videos.map(
            (v, i) => `${i}. "${v.title}" (${v.channelTitle}) [picked as: ${v.tier}; ${v.because}${v.facets ? `; about: ${v.facets.subject}; ${(v.facets.concepts ?? []).join(', ')}` : ''}]`,
          ),
        ].join('\n'),
      },
    ],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return {};
  const out: Record<string, string> = {};
  for (const l of res.parsed_output.lines) if (videos[l.i] && l.why.trim()) out[videos[l.i].id] = l.why.trim();
  return out;
}

// ---------------------------------------------------------------- goodbye idea (kid timer)

const Goodbye = z.object({
  idea: z.string().describe('One thing to do away from the screen now, 1–2 short sentences a 6-year-old understands.'),
});

/** Something to do after TV time ends, sparked by what the child watched today. */
export async function goodbyeIdea(auth: ClaudeAuth, watchedToday: string[]): Promise<string> {
  const res = await client(auth).beta.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(Goodbye) },
    system: forProfile(
      'TV time just ended for today. Suggest one simple, safe thing the child can do now away from the screen that carries on from something they watched: build it, draw it, act it out, find it outside, or tell someone about it. Use things found in any home (paper, boxes, blocks, crayons). Warm and inviting, never preachy.',
    ),
    messages: [{ role: 'user', content: `Watched today: ${watchedToday.join(' | ') || 'nothing in particular'}` }],
  });
  return res.parsed_output?.idea?.trim() ?? '';
}

// ---------------------------------------------------------------- Explore's map

const MapPlace = z.object({
  name: z.string().describe('Short name, 1–4 words, title case.'),
  desc: z.string().describe('One line, under 10 words, saying what is there.'),
  query: z.string().describe("A YouTube search query that finds good videos about this place. It must contain the place's own name."),
  concepts: z.array(z.string()).describe('2–5 lowercase concept tags for it (like "roman engineering", "water").'),
  channels: z
    .array(z.string())
    .describe('2–3 real YouTube channel handles (like "@veritasium") that regularly post good videos about exactly this place. Empty if unsure.'),
});
const MapLevel = z.object({
  children: z.array(MapPlace).describe('The places inside, 6–12, together covering this place well, from best-known to less obvious.'),
  elsewhere: z
    .array(MapPlace.extend({ path: z.array(z.string()).describe("Its full path from a top-level area, ending with the place's own name.") }))
    .describe('1–3 related places in other parts of the map, for hopping sideways.'),
});
export type MapPlaceInfo = z.infer<typeof MapPlace>;
export type MapLevelInfo = z.infer<typeof MapLevel>;

/** The places inside one place on the map (drawn once, then saved). An empty path draws the top level. */
export async function mapChildren(auth: ClaudeAuth, path: string[], areas: string[]): Promise<MapLevelInfo> {
  const top = path.length === 0;
  const res = await client(auth).beta.messages.parse({
    model: FAST_MODEL,
    max_tokens: 6000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(MapLevel) },
    system: forProfile(
      `You draw a map of everything worth watching on YouTube, like the sections of a great library, so a viewer can discover what exists. Given a place on the map, list the places inside it: distinct, concrete, well-known enough to have good videos, and each a real step deeper. Go from familiar to surprising. Names are short and plain.${
        top
          ? ' For the top level, give 12–16 broad areas that together cover everything worth watching, general rather than tuned to any one interest, so that nothing is left without a home.'
          : ` The top-level areas are: ${areas.join(', ')}.`
      }`,
    ),
    messages: [{ role: 'user', content: top ? 'Place: the whole map (draw the top-level areas)' : `Place: ${path.join(' › ')}` }],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('Claude couldn’t draw this part of the map.');
  return res.parsed_output;
}

// ---------------------------------------------------------------- what did they mean? (fast)

const Route = z.object({
  kind: z
    .enum(['place', 'search', 'change'])
    .describe('place: a topic or area to explore ("mountains", "more about volcanoes", "how bridges work"). search: a specific video, channel or person to find ("that Veritasium video about mirrors"). change: a lasting change or a mood for the home feed ("no more true crime", "add a jazz row", "fresh set", "something funny today", "remember I love F1").'),
  reply: z.string().describe('One short, friendly sentence saying what you are doing.'),
  search: z.string().describe('For search: the YouTube search query. Otherwise empty.'),
  place: z
    .object({
      path: z.array(z.string()).describe('Full path from a top-level area to the place, ending with its own name, e.g. ["Nature", "Landforms", "Mountains"]. Reuse existing names exactly.'),
      desc: z.string().describe('One line, under 10 words.'),
      query: z.string().describe("A YouTube search query that finds good videos about it. It must contain the place's own name (what the viewer asked for)."),
      channels: z.array(z.string()).describe('2–3 real YouTube channel handles that regularly post good videos about exactly this. Empty if unsure.'),
      concepts: z.array(z.string()).describe('2–5 lowercase concept tags.'),
    })
    .describe('For place: where it lives on the map. For others: any values (ignored).'),
});
export type RouteResult = z.infer<typeof Route>;

export interface RouteInput {
  request: string;
  topAreas: string[];
  /** Where the viewer is on the map right now, if anywhere. */
  browsing?: string[];
  /** Existing places whose names look related, as full paths. */
  similar: string[][];
}

/** Decide quickly what the viewer meant: a place to explore, a specific search, or a change. */
export async function routeAsk(auth: ClaudeAuth, input: RouteInput): Promise<RouteResult> {
  const res = await client(auth).beta.messages.parse({
    model: FAST_MODEL,
    max_tokens: 8000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(Route) },
    system: forProfile(
      `You route what a viewer says to Wander, a YouTube app with a map of everything worth watching (a tree of places, like library sections). Most requests are places to explore. For a place, put it in its natural home on the map, not simply inside wherever the viewer is now, unless it truly belongs there. If one of the existing similar places is the same thing, return its path exactly instead of making a new one. Expect voice transcription slips.`,
    ),
    messages: [
      {
        role: 'user',
        content: [
          `Viewer said: "${input.request}"`,
          `Top-level areas: ${input.topAreas.join(', ')}`,
          `Viewer is at: ${input.browsing?.length ? input.browsing.join(' › ') : 'the start of Explore'}`,
          `Existing places that may be related: ${input.similar.map((p) => p.join(' › ')).join(' | ') || 'none'}`,
        ].join('\n'),
      },
    ],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error(`Couldn’t route that (${res.stop_reason ?? 'no answer'}).`);
  return res.parsed_output;
}

// ---------------------------------------------------------------- channels for a place (for places drawn before channels existed)

const PlaceChannels = z.object({ channels: z.array(z.string()).describe('2–3 real YouTube channel handles like "@veritasium". Empty if unsure.') });

export async function placeChannels(auth: ClaudeAuth, path: string[]): Promise<string[]> {
  const res = await client(auth).beta.messages.parse({
    model: FAST_MODEL,
    max_tokens: 2000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(PlaceChannels) },
    system: forProfile('Name YouTube channels that regularly post good videos about exactly the given topic. Only real channels you are confident exist, as @handles.'),
    messages: [{ role: 'user', content: `Topic: ${path.join(' › ')}` }],
  });
  return res.parsed_output?.channels ?? [];
}

// ---------------------------------------------------------------- does this video belong to this place? (fast)

const PlaceJudgement = z.object({
  grades: z.array(
    z.object({
      i: z.number().int().describe('The index of the video in the list.'),
      grade: z.number().int().min(0).max(2).describe('2: clearly about this place. 1: partly or loosely. 0: not about it.'),
      child: z.string().describe('If grade > 0: the one listed sub-place it fits best, exactly as written; empty if none fits.'),
    }),
  ),
});

export interface JudgeVideo {
  title: string;
  channel: string;
}

/**
 * Grade a list of videos against one place on Explore's map (Claude Haiku: titles only, fast).
 * Also sorts the good ones into the place's sub-places, so those can open without a new fetch.
 */
export async function judgePlace(
  auth: ClaudeAuth,
  path: string[],
  children: string[],
  videos: JudgeVideo[],
): Promise<{ i: number; grade: 0 | 1 | 2; child: string }[]> {
  if (!videos.length) return [];
  const res = await client(auth).beta.messages.parse({
    model: FAST_MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(PlaceJudgement) },
    system: forProfile(
      'You check which YouTube videos belong on one page of a map of topics. Judge from the title and channel. Be strict: grade 2 only when the video is clearly about this exact place, not just the wider area or a neighbouring topic. Grade every video once.',
    ),
    messages: [
      {
        role: 'user',
        content: [
          `Place: ${path.join(' › ')}`,
          `Sub-places: ${children.join(' | ') || 'none'}`,
          '',
          ...videos.map((v, i) => `${i}. "${v.title}" (${v.channel})`),
        ].join('\n'),
      },
    ],
  });
  return (res.parsed_output?.grades ?? []).map((g) => ({ i: g.i, grade: Math.max(0, Math.min(2, g.grade)) as 0 | 1 | 2, child: g.child.trim() }));
}
