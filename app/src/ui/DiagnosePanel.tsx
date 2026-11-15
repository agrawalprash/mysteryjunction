import { useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { claudeAuth, type ApiKeys } from '../lib/keys.ts';
import { DEFAULT_SYMPTOMS } from '../lib/diagnostics.ts';
import { startDiagnosis, type DiagnosisSession, type Step } from '../lib/investigate.ts';
import { listen } from '../lib/voice.ts';
import { useTv } from './App.tsx';

const TOOL_LABEL: Record<string, string> = {
  device_report: 'DeviceReport',
  run_command: 'Bash',
  package_details: 'AppDetails',
  query_intent: 'IntentHandlers',
  get_setting: 'Setting',
  http_check: 'NetworkCheck',
  speech_test: 'SpeechTest',
  audio_probe: 'MicProbe',
  speak_aloud: 'Speak',
  system_voice_test: 'SystemVoiceTest',
  ask_user: 'AskYou',
};

function describeInput(name: string, input: Record<string, unknown>): string {
  if (name === 'run_command') return String(input.command);
  if (name === 'package_details') return String(input.package);
  if (name === 'query_intent') return String(input.action);
  if (name === 'get_setting') return `${input.table} ${input.key}`;
  if (name === 'http_check') return String(input.url);
  if (name === 'speech_test') return String(input.language);
  if (name === 'speak_aloud') return `${input.language}: “${input.text}”`;
  if (name === 'system_voice_test') return `${input.language}${input.speak_text ? `, says “${input.speak_text}”` : ''}`;
  if (name === 'audio_probe') return `${input.seconds}s, source ${input.source}${Number(input.device_id) > 0 ? `, device ${input.device_id}` : ''}`;
  return '';
}

function firstLines(text: string, n = 3) {
  const lines = text.split('\n').filter((l) => l.trim() && !/^[{}[\],]*$/.test(l.trim()));
  return lines.slice(0, n).join('\n') + (lines.length > n ? `\n… +${lines.length - n} lines` : '');
}

interface Pending {
  question: string;
  options: string[];
  resolve: (answer: string) => void;
}

/** A Claude Code–style session that investigates this device with read-only tools. */
export function DiagnosePanel({ keys }: { keys: ApiKeys }) {
  const tv = useTv();
  const [symptoms, setSymptoms] = useState(DEFAULT_SYMPTOMS);
  const [steps, setSteps] = useState<Step[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const session = useRef<DiagnosisSession | null>(null);
  const log = useRef<Step[]>([]);
  const consoleRef = useRef<HTMLDivElement>(null);

  const sync = () => {
    setSteps(log.current);
    setBusy(!!session.current?.busy);
  };
  const follow = () => {
    // Only follow along while the newest line is near the screen, so reading older output isn't interrupted.
    const el = consoleRef.current?.lastElementChild as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 1.2) window.setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 30);
  };

  const ui = {
    step: (s: Step, index?: number) => {
      if (index === undefined) log.current = [...log.current, s];
      else log.current = log.current.map((x, j) => (j === index ? s : x));
      sync();
      follow();
      return index ?? log.current.length - 1;
    },
    ask: (question: string, options: string[]) =>
      new Promise<string>((resolve) => {
        setPending({ question, options, resolve });
        window.setTimeout(() => document.querySelector<HTMLElement>('.diag-question button')?.focus(), 80);
      }),
  };

  const start = () => {
    const auth = claudeAuth(keys);
    if (!auth) return;
    session.current?.stop();
    log.current = [];
    setSteps([]);
    session.current = startDiagnosis(auth, symptoms, ui);
    window.setTimeout(sync, 0);
    // Keep the busy indicator honest while the session runs.
    const t = window.setInterval(() => {
      sync();
      if (!session.current?.busy) clearInterval(t);
    }, 500);
  };

  const answer = (a: string) => {
    if (!pending || !a.trim()) return;
    pending.resolve(a.trim());
    ui.step({ kind: 'user', text: a.trim() });
    setPending(null);
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setInput('');
    if (pending) return answer(t);
    if (!session.current) return;
    const p = session.current.say(t);
    sync();
    const timer = window.setInterval(sync, 500);
    await p;
    clearInterval(timer);
    sync();
  };

  const speak = async () => {
    try {
      const said = await listen('Say it to Claude');
      if (said) setInput((prev) => (prev ? `${prev} ${said}` : said));
    } catch {
      /* typing still works */
    }
  };

  return (
    <section className="panel">
      <h3>Diagnose with Claude</h3>
      <p className="muted small">
        A Claude Code–style session on this device: Claude runs read-only checks (shell commands, app permissions, voice settings, network tests,
        test phrases spoken by the TV itself, a mic probe), thinks out loud, and keeps going until it has evidence. You can message it at any time.
        Nothing on the device is changed. A run costs roughly 50 cents to $1.
      </p>
      {!session.current && (
        <>
          <label className="small muted">What’s wrong</label>
          <textarea value={symptoms} onChange={(e) => setSymptoms(e.target.value)} />
        </>
      )}
      <div className="end-actions left">
        <button className="btn" onClick={start} disabled={!keys.anthropic || !Capacitor.isNativePlatform()}>
          {session.current ? 'New session' : 'Start'}
        </button>
        {busy && (
          <button className="btn btn-ghost" onClick={() => session.current?.stop()}>
            Stop
          </button>
        )}
      </div>
      {!Capacitor.isNativePlatform() && <p className="muted small">Only works in the installed app.</p>}

      {steps.length > 0 && (
        <div className="term" ref={consoleRef}>
          {steps.map((s, i) => {
            if (s.kind === 'user')
              return (
                <div key={i} className="term-user" tabIndex={-1}>
                  &gt; {s.text}
                  {s.queued && <span className="term-dim"> (queued for the next step)</span>}
                </div>
              );
            if (s.kind === 'thought') return <div key={i} className="term-text">● {s.text}</div>;
            if (s.kind === 'final')
              return (
                <div key={i} className="term-text term-final">
                  ● {s.text}
                </div>
              );
            if (s.kind === 'error') return <div key={i} className="term-error">⎿ {s.text}</div>;
            if (s.kind === 'prompt') return <div key={i} className="term-text">❓ {s.text}</div>;
            return (
              <details key={i} className="term-tool">
                <summary>
                  <span className={s.output === undefined ? 'term-running' : s.error ? 'term-bad' : 'term-ok'}>●</span>{' '}
                  <b>{TOOL_LABEL[s.name] ?? s.name}</b>({describeInput(s.name, s.input)})
                  {s.output !== undefined && <pre className="term-out">⎿ {firstLines(s.output)}</pre>}
                </summary>
                {s.output && <pre className="term-full">{s.output}</pre>}
              </details>
            );
          })}
          {busy && !pending && <div className="term-dim">✻ Working…</div>}
        </div>
      )}

      {pending && (
        <div className="diag-question">
          <p>
            <strong>{pending.question}</strong>
          </p>
          <div className="end-actions left">
            {pending.options.map((o) => (
              <button key={o} className="btn btn-ghost" onClick={() => answer(o)}>
                {o}
              </button>
            ))}
          </div>
        </div>
      )}

      {session.current && (
        <div className="ask-row term-input">
          {!tv && (
            <button className="btn btn-ghost" onClick={speak}>
              🎤
            </button>
          )}
          <form
            className="ask-form"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={pending ? 'Answer…' : busy ? 'Message Claude (it reads it at the next step)…' : 'Message Claude…'}
              enterKeyHint="send"
            />
          </form>
        </div>
      )}
    </section>
  );
}
