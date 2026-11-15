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
  speakAloud(o: { text: string; language: string }): Promise<Json>;
  systemVoiceTest(o: { language: string; speakText: string; delayMs: number }): Promise<Json>;
}>('WanderDiagnostics');

export type Step =
  | { kind: 'thought'; text: string }
  | { kind: 'user'; text: string; queued?: boolean }
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
      'Run ONE read-only command (no shell operators or pipes). Allowed: getprop [key], dumpsys <service> [args] (often "Permission Denial" for an app; that is information too), pm list|path|dump ..., settings get|list <secure|global|system> [key], service list|check, wm size|density, ps [-A], top (one snapshot), ls/cat/grep/head/tail/find/stat on paths under /proc /sys /system /vendor /product /odm, ping <host> (3 packets), ip addr|route|link, uname -a, id, df, uptime, date, which, logcat (only this app\'s own log). Output is truncated to ~7 KB, so filter with arguments (e.g. grep -i voice <file>).',
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
    name: 'speak_aloud',
    description: 'Make the device say a phrase out loud through its speakers with the system text-to-speech engine. Reports the TTS engine, whether that language is supported/installed (LANG_MISSING_DATA / LANG_NOT_SUPPORTED), and whether it spoke. Useful on its own (Google speech/TTS health) and as a known voice source.',
    input_schema: { type: 'object', properties: { text: str, language: str }, required: ['text', 'language'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'system_voice_test',
    description:
      'Open the system\'s own voice-input screen (android.speech.action.RECOGNIZE_SPEECH, the same path YouTube uses) in a language, and optionally have the device speak a known phrase after delay_ms so the owner doesn\'t have to talk. Returns the result code (OK / CANCELED / NO_MATCH / CLIENT / SERVER / NETWORK / AUDIO error) and recognised text, or timedOut after 40 s if the screen never reports back (itself a finding). Whether the remote\'s mic hears the TV speaker without the mic button held is itself something to find out; if needed, ask the owner to hold the button (only hold, not speak).',
    input_schema: {
      type: 'object',
      properties: { language: str, speak_text: str, delay_ms: { type: 'integer' } },
      required: ['language', 'speak_text', 'delay_ms'],
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
- Prefer tests that don't need the owner: speak_aloud and system_voice_test can produce a known phrase in any language through the TV's speakers.
- The owner can send you messages at any time; they arrive as "Message from the owner". Take them into account immediately. After your answer the conversation continues, so keep context and follow up on what they ask.
- Format: plain text, short paragraphs and simple lists; no tables or Markdown headings syntax (headings as plain lines ending with a colon are fine).
Background: on Android TV the remote's mic streams over Bluetooth only while the Assistant button is held, to the system's voice service (often com.google.android.katniss); the Google TV phone app sends voice to the same service. If both fail, the shared parts are that service, its account/language settings, and the network path to Google.`;

const MAX_STEPS = 24;

/** How long each kind of check may take before Claude is told it timed out (0 = waits for the owner). */
const TOOL_TIME_LIMIT_MS: Record<string, number> = {
  ask_user: 0,
  speech_test: 0, // starts with a question to the owner; the native test itself stops after 15 s
  audio_probe: 0, // likewise; recording is at most 10 s
  system_voice_test: 40_000,
  speak_aloud: 30_000,
  device_report: 45_000,
  http_check: 20_000,
  run_command: 20_000,
};

export interface SessionDeps {
  /** Sends one request, streaming text to onText(snapshotOfCurrentTextBlock). */
  send: (params: Anthropic.Beta.MessageCreateParams, onText: (snapshot: string) => void, signal: { abort?: () => void }) => Promise<Anthropic.Beta.BetaMessage>;
  runTool: typeof runTool;
  /** Overrides the per-tool time limits (tests). */
  limits?: Record<string, number>;
}

/**
 * A Claude Code–style diagnosis session: Claude streams its reasoning, runs tools,
 * and the owner can send messages at any time (queued into the next step while
 * Claude works; a new turn when it's idle). The conversation continues after an answer.
 */
export class DiagnosisSession {
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private notes: string[] = [];
  private running = false;
  private cancelled = false;
  private abortHandle: { abort?: () => void } = {};
  private deps: SessionDeps;
  private ui: InvestigationUi;

  constructor(auth: ClaudeAuth, ui: InvestigationUi, deps?: Partial<SessionDeps>) {
    this.ui = ui;
    this.deps = {
      runTool,
      send: async (params, onText, signal) => {
        const stream = client(auth).beta.messages.stream(params as Anthropic.Beta.MessageCreateParamsNonStreaming);
        signal.abort = () => stream.abort();
        stream.on('text', (_delta, snapshot) => onText(snapshot));
        return stream.finalMessage();
      },
      ...deps,
    };
  }

  get busy() {
    return this.running;
  }

  /** The owner says something. While Claude works it's passed in at the next step. */
  async say(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    if (this.running) {
      this.notes.push(t);
      this.ui.step({ kind: 'user', text: t, queued: true });
      return;
    }
    this.ui.step({ kind: 'user', text: t });
    this.appendUser([{ type: 'text', text: t }]);
    await this.loop();
  }

  stop() {
    this.cancelled = true;
    this.abortHandle.abort?.();
    // Also give up on a check that's still waiting (e.g. a voice screen that never answers).
    this.cancelWaiting?.();
  }

  private cancelWaiting: (() => void) | null = null;

  /** Runs a tool, but never waits forever: each kind of check has a time limit, and Stop ends the wait. */
  private runWithLimit(name: string, input: Json): Promise<unknown> {
    const limitMs = (this.deps.limits ?? TOOL_TIME_LIMIT_MS)[name] ?? 30_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelWaiting = null;
        fn();
      };
      const timer = limitMs
        ? setTimeout(
            () =>
              done(() =>
                resolve({
                  timedOut: true,
                  afterSeconds: limitMs / 1000,
                  note:
                    name === 'system_voice_test'
                      ? 'The system voice screen gave no result to the app within the time limit (it may still be open, may have closed without reporting, or may not return results to apps on this device). Ask the owner what they see on screen.'
                      : 'No result within the time limit.',
                }),
              ),
            limitMs,
          )
        : 0;
      this.cancelWaiting = () => done(() => reject(new Error('Stopped by the owner.')));
      this.deps.runTool(name, input, this.ui).then(
        (v) => done(() => resolve(v)),
        (e) => done(() => reject(e)),
      );
    });
  }

  /** Adds content to the conversation as the owner, closing any tool calls a Stop left open. */
  private appendUser(content: Anthropic.Beta.BetaContentBlockParam[]) {
    const last = this.messages[this.messages.length - 1];
    const open =
      last?.role === 'assistant' && Array.isArray(last.content)
        ? (last.content as Anthropic.Beta.BetaContentBlockParam[]).filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id)
        : [];
    const closing: Anthropic.Beta.BetaContentBlockParam[] = open.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'Stopped by the owner.', is_error: true }));
    if (last?.role === 'user' && Array.isArray(last.content)) {
      last.content = [...(last.content as Anthropic.Beta.BetaContentBlockParam[]), ...content];
    } else {
      this.messages.push({ role: 'user', content: [...closing, ...content] });
    }
  }

  private async loop() {
    this.running = true;
    this.cancelled = false;
    try {
      for (let turn = 0; turn <= MAX_STEPS; turn++) {
        let textStep = -1;
        let lastLen = 0;
        const onText = (snapshot: string) => {
          // A new text block starts with a shorter snapshot.
          if (textStep === -1 || snapshot.length < lastLen) textStep = this.ui.step({ kind: 'thought', text: snapshot });
          else this.ui.step({ kind: 'thought', text: snapshot }, textStep);
          lastLen = snapshot.length;
        };
        this.abortHandle = {};
        const res = await this.deps.send(
          {
            model: MODEL,
            max_tokens: 16000,
            ...FALLBACK,
            output_config: { effort: 'high' },
            cache_control: { type: 'ephemeral' },
            system: SYSTEM,
            tools: TOOLS,
            ...(turn >= MAX_STEPS ? { tool_choice: { type: 'none' as const } } : {}),
            messages: this.messages,
          },
          onText,
          this.abortHandle,
        );
        // Keep the assistant turn exactly as returned (thinking blocks included).
        this.messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
        if (res.stop_reason === 'refusal') throw new Error('Claude declined to continue.');
        if (res.stop_reason !== 'tool_use') {
          if (textStep >= 0) {
            const text = res.content
              .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
              .trim();
            this.ui.step({ kind: 'final', text }, textStep);
          }
          return;
        }
        const results: Anthropic.Beta.BetaContentBlockParam[] = [];
        for (const b of res.content) {
          if (b.type !== 'tool_use') continue;
          if (this.cancelled) throw new Error('Stopped.');
          const input = (b.input ?? {}) as Json;
          const idx = this.ui.step({ kind: 'tool', name: b.name, input });
          let output: string;
          let isError = false;
          try {
            output = JSON.stringify(await this.runWithLimit(b.name, input), null, 1);
          } catch (e) {
            output = `Tool failed: ${e instanceof Error ? e.message : String(e)}`;
            isError = true;
          }
          this.ui.step({ kind: 'tool', name: b.name, input, output, error: isError }, idx);
          results.push({ type: 'tool_result', tool_use_id: b.id, content: output.slice(0, 12000), is_error: isError });
        }
        // Everything for this step goes back in one message: all tool results, then any notes from the owner.
        for (const n of this.notes.splice(0)) results.push({ type: 'text', text: `Message from the owner (sent while you were working): ${n}` });
        if (turn === MAX_STEPS - 1) results.push({ type: 'text', text: 'That was the last check for now. Write your answer.' });
        this.messages.push({ role: 'user', content: results });
        if (this.cancelled) throw new Error('Stopped.');
      }
    } catch (e) {
      const stopped = this.cancelled || (e instanceof Error && /abort/i.test(e.name + e.message));
      this.ui.step({ kind: 'error', text: stopped ? 'Stopped. Say what to do next, or ask Claude to carry on.' : e instanceof Error ? e.message : String(e) });
    } finally {
      this.running = false;
      // Notes that arrived after the last step become the next turn.
      const left = this.notes.splice(0);
      if (left.length && !this.cancelled) {
        this.appendUser([{ type: 'text', text: left.join('\n') }]);
        void this.loop();
      }
    }
  }
}

/** Starts a session with the owner's description of the problem. */
export function startDiagnosis(auth: ClaudeAuth, symptoms: string, ui: InvestigationUi, deps?: Partial<SessionDeps>) {
  const session = new DiagnosisSession(auth, ui, deps);
  void session.say(
    `${symptoms}\n\n(Wander ${__APP_VERSION__}; screen ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x CSS px.)`,
  );
  return session;
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
    case 'speak_aloud':
      return Diag.speakAloud({ text: String(input.text ?? ''), language: String(input.language ?? 'en-US') });
    case 'system_voice_test':
      return Diag.systemVoiceTest({
        language: String(input.language ?? 'en-US'),
        speakText: String(input.speak_text ?? ''),
        delayMs: Number(input.delay_ms) || 1500,
      });
    case 'ask_user': {
      const answer = await ui.ask(String(input.question ?? ''), (input.options as string[]) ?? []);
      return { answer };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
