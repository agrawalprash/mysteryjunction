// A real diagnosis: Claude investigates the device step by step with read-only
// tools (commands, app details, settings, network checks, a mic probe, a live
// speech test) and can ask the viewer to do things. Every step is shown on screen.

import type Anthropic from '@anthropic-ai/sdk';
import { registerPlugin } from '@capacitor/core';
import { client, FALLBACK, MODEL, type ClaudeAuth } from './claude.ts';

declare const __APP_VERSION__: string;

type Json = Record<string, unknown>;
const Diag = registerPlugin<{
  collect(): Promise<Json>;
  speechTest(o: { language?: string }): Promise<Json>;
  runCommand(o: { command: string }): Promise<Json>;
  packageDetails(o: { package: string }): Promise<Json>;
  queryIntent(o: { action: string }): Promise<Json>;
  getSetting(o: { table: string; key: string }): Promise<Json>;
  httpCheck(o: { url: string }): Promise<Json>;
  audioProbe(o: { seconds?: number; source?: number; deviceId?: number }): Promise<Json>;
}>('WanderDiagnostics');

export type Step =
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; name: string; input: Json; output?: string; error?: boolean }
  | { kind: 'prompt'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'error'; text: string };

export interface InvestigationUi {
  /** Adds or updates a step on screen; returns its index. */
  step(s: Step, index?: number): number;
  /** Asks the viewer something and waits for their answer. */
  ask(question: string, options: string[]): Promise<string>;
}

const str = { type: 'string' } as const;
const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'device_report',
    description: 'Snapshot of the device: model/Android version, default assistant & voice settings, recognition services, voice-related apps (version, enabled, mic permission), audio inputs (with ids), input devices, Bluetooth devices, network (DNS, private DNS, VPN) and reachability of common Google hosts. Good first step.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: 'run_command',
    description:
      'Run ONE read-only command (no shell operators). Allowed: getprop [key], dumpsys <service> [args] (often "Permission Denial" for an app; that is information too), pm list|path|dump ..., settings get|list <secure|global|system> [key], ls/cat under /proc /sys /system /vendor /product /odm, ping <host> (3 packets), ip addr|route|link, uname -a, id, df, uptime, date, logcat (only this app\'s own log). Output is truncated to ~7 KB, so filter with arguments where possible.',
    input_schema: { type: 'object', properties: { command: str }, required: ['command'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'package_details',
    description: 'Details of one installed app: version, enabled/disabled state, system/updated flags, voice/audio/Bluetooth/internet permissions and whether each is granted (✓/✗), voice-related services.',
    input_schema: { type: 'object', properties: { package: str }, required: ['package'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'query_intent',
    description: 'Which activities/services handle an intent action (e.g. android.speech.action.RECOGNIZE_SPEECH, android.intent.action.ASSIST, android.speech.RecognitionService, android.service.voice.VoiceInteractionService), and the default handler.',
    input_schema: { type: 'object', properties: { action: str }, required: ['action'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'get_setting',
    description: 'Read one Android setting value.',
    input_schema: {
      type: 'object',
      properties: { table: { type: 'string', enum: ['secure', 'global', 'system'] }, key: str },
      required: ['table', 'key'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'http_check',
    description: 'DNS-resolve a URL\'s host and make one HTTPS request (no redirects followed): returns IPs, status, timing or the error. Use to test whether specific Google endpoints are reachable or filtered.',
    input_schema: { type: 'object', properties: { url: str }, required: ['url'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'speech_test',
    description: 'Run Android\'s SpeechRecognizer in this app for up to 15 s in the given language (e.g. en-US, de-DE). Returns recognised text or the exact error name, max input level (rms dB) and events. The viewer is told to speak. Note: an Android TV usually has no built-in mic, so this tests whatever input the system routes to apps.',
    input_schema: { type: 'object', properties: { language: str, what_to_say: str }, required: ['language', 'what_to_say'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'audio_probe',
    description: 'Record a few seconds directly with AudioRecord and report loudness per quarter second, peak, and which input device was used. Choose an input by device id from device_report audioInputs (0 = system default) and an audio source (1=MIC, 6=VOICE_RECOGNITION, 7=VOICE_COMMUNICATION). Shows the viewer an instruction first (e.g. "Hold the Assistant button and speak now").',
    input_schema: {
      type: 'object',
      properties: {
        seconds: { type: 'integer' },
        source: { type: 'integer' },
        device_id: { type: 'integer' },
        instruction: str,
      },
      required: ['seconds', 'source', 'device_id', 'instruction'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'ask_user',
    description: 'Ask the viewer to do or check something only they can (press a button, open a menu, read a value on screen) and wait for their answer. Keep it to one clear action. Offer short answer options.',
    input_schema: {
      type: 'object',
      properties: { question: str, options: { type: 'array', items: str } },
      required: ['question', 'options'],
      additionalProperties: false,
    },
    strict: true,
  },
];

const SYSTEM = `You are investigating a problem on the owner's Android device (usually an Android TV stick) from inside the Wander app, which gives you read-only diagnostic tools. Work like a careful technician:
- Start from the owner's description and a device_report. Form explicit hypotheses, then run the checks that best separate them. Prefer decisive tests (e.g. run speech_test in en-US and de-DE to test a language theory; http_check specific endpoints to test network filtering; audio_probe while the owner holds the remote's mic button to see whether any audio reaches the device).
- Before each tool call, write one short line saying what you're checking and why (the owner reads these live). After surprising results, say what changed in your thinking.
- A refused command or "Permission Denial" is information about what an app can see, not a dead end; move on.
- Ask the owner for physical actions only when needed, one at a time.
- Don't change anything on the device; your tools can't, and don't suggest risky changes (factory reset only as a clearly-labelled last resort).
- Stop when you have enough evidence or after about 20 tool calls. Then write the final answer in plain English for a non-technical owner, with these headings:
  What I found (the facts you verified, with the values),
  Most likely cause (and how sure you are),
  Ruled out,
  What to do next (numbered, exact menu paths for this device; say which step tests what),
  What I couldn't check from inside an app.
Background: on Android TV the remote's mic streams over Bluetooth only while the Assistant button is held, to the system's voice service (often com.google.android.katniss); the Google TV phone app sends voice to the same service. If both fail, the shared parts are that service, its account/language settings, and the network path to Google.`;

const MAX_STEPS = 24;

export interface InvestigationDeps {
  create: (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;
  runTool: typeof runTool;
}

export async function investigate(
  auth: ClaudeAuth,
  symptoms: string,
  ui: InvestigationUi,
  isCancelled: () => boolean,
  deps?: Partial<InvestigationDeps>,
): Promise<string> {
  const create = deps?.create ?? ((p) => client(auth).beta.messages.create(p));
  const run = deps?.runTool ?? runTool;
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: 'user',
      content: `The owner says:\n${symptoms}\n\n(Wander ${__APP_VERSION__}; screen ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x CSS px.)`,
    },
  ];
  for (let turn = 0; turn < MAX_STEPS + 2; turn++) {
    if (isCancelled()) throw new Error('Stopped.');
    const res = await create({
      model: MODEL,
      max_tokens: 16000,
      ...FALLBACK,
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      tools: TOOLS,
      // Out of steps: no more tools, write the answer.
      ...(turn >= MAX_STEPS ? { tool_choice: { type: 'none' as const } } : {}),
      messages,
    });
    // Keep the assistant turn exactly as returned (thinking blocks included).
    messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    for (const b of res.content) if (b.type === 'text' && b.text.trim() && res.stop_reason === 'tool_use') ui.step({ kind: 'thought', text: b.text.trim() });

    if (res.stop_reason === 'refusal') throw new Error('Claude declined to continue this investigation.');
    if (res.stop_reason !== 'tool_use') {
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      ui.step({ kind: 'final', text: text || '(Claude finished without a written answer.)' });
      return text;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const b of res.content) {
      if (b.type !== 'tool_use') continue;
      if (isCancelled()) throw new Error('Stopped.');
      const input = (b.input ?? {}) as Json;
      const idx = ui.step({ kind: 'tool', name: b.name, input });
      let output: string;
      let isError = false;
      try {
        output = JSON.stringify(await run(b.name, input, ui), null, 1);
      } catch (e) {
        output = `Tool failed: ${e instanceof Error ? e.message : String(e)}`;
        isError = true;
      }
      ui.step({ kind: 'tool', name: b.name, input, output, error: isError }, idx);
      results.push({ type: 'tool_result', tool_use_id: b.id, content: output.slice(0, 12000), is_error: isError });
    }
    // All results for this turn go back in one message.
    const content: Anthropic.Beta.BetaContentBlockParam[] = [...results];
    if (turn === MAX_STEPS - 1) content.push({ type: 'text', text: 'That was the last check. Write your final answer now.' });
    messages.push({ role: 'user', content });
  }
  throw new Error('The investigation ran too long without an answer.');
}

async function runTool(name: string, input: Json, ui: InvestigationUi): Promise<unknown> {
  switch (name) {
    case 'device_report':
      return Diag.collect();
    case 'run_command':
      return Diag.runCommand({ command: String(input.command ?? '') });
    case 'package_details':
      return Diag.packageDetails({ package: String(input.package ?? '') });
    case 'query_intent':
      return Diag.queryIntent({ action: String(input.action ?? '') });
    case 'get_setting':
      return Diag.getSetting({ table: String(input.table ?? 'secure'), key: String(input.key ?? '') });
    case 'http_check':
      return Diag.httpCheck({ url: String(input.url ?? '') });
    case 'speech_test': {
      const ready = await ui.ask(`Speech test (${input.language}): when you press Start, say “${input.what_to_say}”.`, ['Start', 'Skip']);
      if (ready !== 'Start') return { skipped: 'The owner skipped this test.' };
      return Diag.speechTest({ language: String(input.language ?? 'en-US') });
    }
    case 'audio_probe': {
      const ready = await ui.ask(`${input.instruction} (recording starts when you press Start and runs ${input.seconds} s)`, ['Start', 'Skip']);
      if (ready !== 'Start') return { skipped: 'The owner skipped this test.' };
      const deviceId = Number(input.device_id);
      return Diag.audioProbe({
        seconds: Number(input.seconds) || 4,
        source: Number(input.source) || 6,
        ...(deviceId > 0 ? { deviceId } : {}),
      });
    }
    case 'ask_user': {
      const answer = await ui.ask(String(input.question ?? ''), (input.options as string[]) ?? []);
      return { answer };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
