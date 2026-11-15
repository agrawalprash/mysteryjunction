// All Claude calls the app makes:
//  - planDay / planSurprise: which YouTube searches to run (daily, and per "Surprise me")
//  - describeVideos: subject / format / pace / depth / clickbait for each candidate (daily)
//  - writeTasteProfile: a written read of the viewer's taste from their history (weekly)

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { FORMATS, type Candidate, type CustomRow, type Direction, type ExitRecord, type Facets, type TasteProfile, type WatchRecord } from '../engine/types.ts';

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
- Write every query, topic and "because" in the viewer's language.`;

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
    .map((i) => ({ topic: i.topic.trim(), query: i.query.trim(), because: i.because.trim(), tier }));
}

/** How many searches of each kind one set uses (100 YouTube quota units each). */
export function planShape(input: Pick<PlannerInput, 'focus' | 'customRows'>) {
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
    system: PLAN_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `${describeViewer(input)}\n\nPlan the next set: ${ask}.`,
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

// ---------------------------------------------------------------- talking to Wander

const Ask = z.object({
  reply: z.string().describe('1–2 short, warm sentences to the viewer saying what you are doing. No questions back.'),
  new_set: z.boolean().describe('Build a fresh set of videos now.'),
  focus: z.string().describe('What the new set should centre on (e.g. "music: live sessions and world music"). Empty if none.'),
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
  ];
  const res = await client(auth).beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    ...FALLBACK,
    output_config: { effort: 'low', format: betaZodOutputFormat(Ask) },
    system: ASK_SYSTEM,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('Claude didn’t answer that one. Try saying it differently.');
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
