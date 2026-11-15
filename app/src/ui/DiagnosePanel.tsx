import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { claudeAuth, type ApiKeys } from '../lib/keys.ts';
import { DEFAULT_SYMPTOMS } from '../lib/diagnostics.ts';
import { diagSnapshot, sayDiag, startDiag, stopDiag, subscribeDiag, type DiagSnapshot } from '../lib/diagStore.ts';
import { linkedTv, sendToTv } from '../lib/link.ts';
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

type Target = 'here' | 'tv';

const EMPTY: DiagSnapshot = { active: false, busy: false, steps: [], pending: null };

/** Session state for this device (shared store) or for the linked TV (polled over Wi-Fi). */
function useDiag(target: Target) {
  const [snap, setSnap] = useState<DiagSnapshot>(target === 'here' ? diagSnapshot() : EMPTY);
  const [linkError, setLinkError] = useState('');

  useEffect(() => {
    if (target === 'here') {
      setSnap(diagSnapshot());
      const off = subscribeDiag(() => setSnap(diagSnapshot()));
      const t = window.setInterval(() => setSnap(diagSnapshot()), 1000);
      return () => {
        off();
        clearInterval(t);
      };
    }
    let alive = true;
    const poll = async () => {
      try {
        const s = (await sendToTv({ type: 'diag', action: 'state' })) as DiagSnapshot;
        if (alive) {
          setSnap(s);
          setLinkError('');
        }
      } catch (e) {
        if (alive) setLinkError(e instanceof Error ? e.message : String(e));
      }
    };
    poll();
    const t = window.setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [target]);

  const act = async (action: 'start' | 'say' | 'stop', text?: string) => {
    if (target === 'here') return;
    try {
      setSnap((await sendToTv({ type: 'diag', action, text })) as DiagSnapshot);
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : String(e));
    }
  };
  return { snap, linkError, act };
}

/** A Claude Code–style session that investigates a device with read-only tools. */
export function DiagnosePanel({ keys }: { keys: ApiKeys }) {
  const tv = useTv();
  const tvLink = !tv ? linkedTv() : null;
  const [target, setTarget] = useState<Target>(tvLink ? 'tv' : 'here');
  const { snap, linkError, act } = useDiag(target);
  const [symptoms, setSymptoms] = useState(DEFAULT_SYMPTOMS);
  const [input, setInput] = useState('');
  const consoleRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);
  const { steps, pending, busy, active } = snap;

  // Follow new lines only while the newest one is near the screen, so reading older output isn't interrupted.
  useEffect(() => {
    if (steps.length === lastCount.current) return;
    lastCount.current = steps.length;
    const el = consoleRef.current?.lastElementChild as HTMLElement | null;
    if (el && el.getBoundingClientRect().top < window.innerHeight * 1.2) el.scrollIntoView({ block: 'nearest' });
  }, [steps.length]);

  useEffect(() => {
    if (pending) window.setTimeout(() => document.querySelector<HTMLElement>('.diag-question button')?.focus(), 80);
  }, [pending?.question]);

  const start = () => {
    if (target === 'tv') return act('start', symptoms);
    const auth = claudeAuth(keys);
    if (auth) startDiag(auth, symptoms);
  };
  const send = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setInput('');
    if (target === 'tv') act('say', t);
    else sayDiag(t);
  };
  const stop = () => (target === 'tv' ? act('stop') : stopDiag());

  const speak = async () => {
    try {
      const said = await listen('Say it to Claude');
      if (said) setInput((prev) => (prev ? `${prev} ${said}` : said));
    } catch {
      /* typing still works */
    }
  };

  const canRunHere = Capacitor.isNativePlatform() && !!keys.anthropic;

  return (
    <section className="panel">
      <h3>Diagnose with Claude</h3>
      <p className="muted small">
        A Claude Code–style session: Claude runs read-only checks on the device (shell commands, app permissions, voice settings, network tests,
        test phrases spoken by the TV itself, a mic probe), thinks out loud, and keeps going until it has evidence. Message it at any time. Nothing
        is changed. A run costs roughly 50 cents to $1.
      </p>
      {tvLink && (
        <div className="target-row">
          <span className="muted small">Diagnose</span>
          <button className={`chip${target === 'tv' ? ' chip-on' : ''}`} onClick={() => setTarget('tv')}>
            📺 TV (type here)
          </button>
          <button className={`chip${target === 'here' ? ' chip-on' : ''}`} onClick={() => setTarget('here')}>
            This phone
          </button>
        </div>
      )}
      {!active && (
        <>
          <label className="small muted">What’s wrong</label>
          <textarea value={symptoms} onChange={(e) => setSymptoms(e.target.value)} />
        </>
      )}
      <div className="end-actions left">
        <button className="btn" onClick={start} disabled={target === 'here' && !canRunHere}>
          {active ? 'New session' : 'Start'}
        </button>
        {busy && (
          <button className="btn btn-ghost" onClick={stop}>
            Stop
          </button>
        )}
      </div>
      {target === 'here' && !Capacitor.isNativePlatform() && <p className="muted small">Only works in the installed app.</p>}
      {linkError && <p className="small error-text">{linkError}</p>}
      {target === 'tv' && !active && !linkError && <p className="muted small">Wander needs to be open on the TV.</p>}

      {steps.length > 0 && (
        <div className="term" ref={consoleRef}>
          {steps.map((s, i) => {
            if (s.kind === 'user')
              return (
                <div key={i} className="term-user">
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
              <button key={o} className="btn btn-ghost" onClick={() => send(o)}>
                {o}
              </button>
            ))}
          </div>
        </div>
      )}

      {active && (
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
