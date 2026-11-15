import { useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { claudeAuth, type ApiKeys } from '../lib/keys.ts';
import { DEFAULT_SYMPTOMS } from '../lib/diagnostics.ts';
import { investigate, type Step } from '../lib/investigate.ts';
import { listen } from '../lib/voice.ts';
import { useTv } from './App.tsx';

const TOOL_LABEL: Record<string, string> = {
  device_report: 'Device report',
  run_command: 'Command',
  package_details: 'App details',
  query_intent: 'Who handles',
  get_setting: 'Setting',
  http_check: 'Network check',
  speech_test: 'Live speech test',
  audio_probe: 'Microphone probe',
  ask_user: 'Question for you',
};

function describeInput(name: string, input: Record<string, unknown>): string {
  if (name === 'run_command') return String(input.command);
  if (name === 'package_details') return String(input.package);
  if (name === 'query_intent') return String(input.action);
  if (name === 'get_setting') return `${input.table} ${input.key}`;
  if (name === 'http_check') return String(input.url);
  if (name === 'speech_test') return String(input.language);
  if (name === 'audio_probe') return `${input.seconds}s, source ${input.source}${Number(input.device_id) > 0 ? `, device ${input.device_id}` : ''}`;
  return '';
}

interface Pending {
  question: string;
  options: string[];
  resolve: (answer: string) => void;
}

/** Claude investigates this device with read-only tools; every step is shown as it happens. */
export function DiagnosePanel({ keys }: { keys: ApiKeys }) {
  const tv = useTv();
  const [symptoms, setSymptoms] = useState(DEFAULT_SYMPTOMS);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [answer, setAnswer] = useState('');
  const cancelled = useRef(false);
  // The list of steps lives in a ref so the investigation can address steps by index synchronously.
  const log = useRef<Step[]>([]);
  const push = (s: Step) => {
    log.current = [...log.current, s];
    setSteps(log.current);
    return log.current.length - 1;
  };
  const replaceAt = (i: number, s: Step) => {
    log.current = log.current.map((x, j) => (j === i ? s : x));
    setSteps(log.current);
  };
  const consoleRef = useRef<HTMLDivElement>(null);

  const follow = () =>
    window.setTimeout(() => consoleRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);

  const start = async () => {
    const auth = claudeAuth(keys);
    if (!auth) return;
    cancelled.current = false;
    log.current = [];
    setSteps([]);
    setRunning(true);
    try {
      await investigate(
        auth,
        symptoms,
        {
          step: (s, index) => {
            follow();
            if (index === undefined) return push(s);
            replaceAt(index, s);
            return index;
          },
          ask: (question, options) =>
            new Promise<string>((resolve) => {
              setAnswer('');
              setPending({ question, options, resolve });
              push({ kind: 'prompt', text: question });
              window.setTimeout(() => document.querySelector<HTMLElement>('.diag-question button')?.focus(), 80);
              follow();
            }),
        },
        () => cancelled.current,
      );
    } catch (e) {
      push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
      setPending(null);
    }
  };

  const reply = (a: string) => {
    if (!pending || !a.trim()) return;
    pending.resolve(a.trim());
    push({ kind: 'thought', text: `You: ${a.trim()}` });
    setPending(null);
  };

  return (
    <section className="panel">
      <h3>Diagnose with Claude</h3>
      <p className="muted small">
        Claude investigates this device itself: it runs read-only checks (commands like getprop and dumpsys, app permissions, voice settings,
        network tests, a microphone probe, live speech tests in different languages), asks you to press things when needed, and explains what it
        found. Nothing is changed. A run takes a few minutes and costs roughly 50 cents to $1 in Claude usage.
      </p>
      <label className="small muted">What’s wrong (edit if needed)</label>
      <textarea value={symptoms} onChange={(e) => setSymptoms(e.target.value)} disabled={running} />
      <div className="end-actions left">
        {!running ? (
          <button className="btn" onClick={start} disabled={!keys.anthropic || !Capacitor.isNativePlatform()}>
            {steps.length ? 'Investigate again' : 'Start investigation'}
          </button>
        ) : (
          <button
            className="btn btn-ghost"
            onClick={() => {
              cancelled.current = true;
              pending?.resolve('The owner stopped the investigation.');
            }}
          >
            Stop
          </button>
        )}
      </div>
      {!Capacitor.isNativePlatform() && <p className="muted small">Only works in the installed app.</p>}

      {steps.length > 0 && (
        <div className="diag-console" ref={consoleRef}>
          {steps.map((s, i) => {
            if (s.kind === 'thought') return <p key={i} className="diag-thought">✦ {s.text}</p>;
            if (s.kind === 'prompt') return <p key={i} className="diag-prompt">❓ {s.text}</p>;
            if (s.kind === 'error') return <p key={i} className="small error-text">{s.text}</p>;
            if (s.kind === 'final')
              return (
                <div key={i} className="diag-final">
                  <h4>Claude’s diagnosis</h4>
                  <div className="diag-final-text">{s.text}</div>
                </div>
              );
            return (
              <details key={i} className={`diag-tool${s.error ? ' diag-tool-error' : ''}`}>
                <summary>
                  {s.output === undefined ? '⏳' : s.error ? '✗' : '▶'} {TOOL_LABEL[s.name] ?? s.name}
                  {describeInput(s.name, s.input) && <code> {describeInput(s.name, s.input)}</code>}
                </summary>
                {s.output && <pre className="raw">{s.output}</pre>}
              </details>
            );
          })}
          {running && !pending && (
            <div className="ask-progress">
              <div className="spinner small-spinner" /> Claude is working…
            </div>
          )}
        </div>
      )}

      {pending && (
        <div className="diag-question">
          <p>
            <strong>{pending.question}</strong>
          </p>
          <div className="end-actions left">
            {pending.options.map((o) => (
              <button key={o} className="btn btn-ghost" onClick={() => reply(o)}>
                {o}
              </button>
            ))}
          </div>
          <div className="ask-row">
            {!tv && (
              <button
                className="btn btn-ghost"
                onClick={async () => {
                  try {
                    const said = await listen('Your answer');
                    if (said) setAnswer(said);
                  } catch {
                    /* typing still works */
                  }
                }}
              >
                🎤
              </button>
            )}
            <form
              className="ask-form"
              onSubmit={(e) => {
                e.preventDefault();
                reply(answer);
              }}
            >
              <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="…or type your own answer" />
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
