import { useEffect, useRef, useState } from 'react';
import type { DailyFeed } from '../engine/types.ts';
import type { ApiKeys } from '../lib/keys.ts';
import { ask, getTold, mergeTold } from '../lib/wander.ts';
import { listen } from '../lib/voice.ts';
import { linkedTv, sendToTv } from '../lib/link.ts';
import { toast } from '../lib/toast.ts';
import { focusFirst } from '../lib/spatialNav.ts';
import { useTv } from './App.tsx';

const SUGGESTIONS = [
  'I’m in the mood for music today',
  'Something light and funny',
  'Give me a fresh set',
  'Add a row for great documentaries',
  'Remember that I love space',
];

/** "Ask Wander": say or type what you want; Claude changes the feed or remembers it. */
export function AskSheet({
  keys,
  startWithVoice,
  onClose,
  onFeed,
}: {
  keys: ApiKeys;
  startWithVoice: boolean;
  onClose: () => void;
  onFeed: (f: DailyFeed) => void;
}) {
  const tv = useTv();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [changes, setChanges] = useState<string[]>([]);
  const [error, setError] = useState('');
  const started = useRef(false);
  const open = useRef(true);
  const tvLink = !tv ? linkedTv() : null;
  const [target, setTarget] = useState<'here' | 'tv'>(tvLink ? 'tv' : 'here');

  useEffect(() => {
    // On TV, move focus into the panel so the remote controls it.
    if (tv) window.setTimeout(() => focusFirst(), 30);
    return () => {
      open.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (said: string) => {
    const t = said.trim();
    if (!t || busy) return;
    setBusy(true);
    // On TV the focused control may become disabled; keep focus somewhere usable.
    if (tv) window.setTimeout(() => document.querySelector<HTMLElement>('[data-close]')?.focus(), 30);
    setError('');
    setReply('');
    setChanges([]);
    setHeard(t);
    try {
      if (target === 'tv') {
        setProgress('Sending to the TV… (Claude replies there too)');
        const out = await sendToTv({ type: 'ask', text: t });
        setReply(out.reply ?? 'Sent.');
        if (out.notice) setError(out.notice);
        setChanges([...(out.changes ?? []), ...(out.newSet ? ['The TV is showing a new set'] : [])]);
        // Keep rows, interests and rules the same on both devices.
        const synced = await sendToTv({ type: 'sync', told: getTold() }).catch(() => null);
        if (synced?.told) mergeTold(synced.told);
        if (!open.current) toast(`📺 ${out.reply ?? 'Sent to the TV.'}`);
        return;
      }
      const out = await ask(keys, t, setProgress);
      setReply(out.reply);
      setChanges(out.changes);
      if (out.notice) setError(out.notice);
      if (out.feed) {
        onFeed(out.feed);
        // The new set is ready: get out of the way so it can be seen.
        if (open.current) window.setTimeout(onClose, out.changes.length ? 2200 : 1200);
      }
      // Closed while Claude was thinking: tell them how it went.
      if (!open.current) toast(`✦ ${out.reply}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      if (!open.current) toast(`Couldn’t do that: ${msg}`);
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const speak = async () => {
    setError('');
    try {
      const said = await listen();
      if (said) await submit(said);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/no voice recognition/i.test(msg) ? `${msg} You can type instead.` : msg);
    }
  };

  useEffect(() => {
    if (startWithVoice && !started.current) {
      started.current = true;
      speak();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startWithVoice]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Ask Wander">
        <h2>
          <span className="logo-mark">✦</span> Ask Wander
        </h2>
        <p className="muted small">
          Ask for a mood (“music today”), a new set, a lasting row (“add a row for live jazz”), something to remember (“I love maritime history”), or
          a rule (“no true crime”).
        </p>

        {tvLink && (
          <div className="target-row">
            <span className="muted small">Send to</span>
            <button className={`chip${target === 'here' ? ' chip-on' : ''}`} onClick={() => setTarget('here')} disabled={busy}>
              This phone
            </button>
            <button className={`chip${target === 'tv' ? ' chip-on' : ''}`} onClick={() => setTarget('tv')} disabled={busy}>
              📺 TV
            </button>
          </div>
        )}

        <div className="ask-row">
          <button className="btn mic-btn" onClick={speak} disabled={busy} data-autofocus>
            🎤 {tv ? 'Speak' : 'Talk'}
          </button>
          <form
            className="ask-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit(text);
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="…or type here" enterKeyHint="send" disabled={busy} />
          </form>
        </div>

        {!heard && (
          <div className="chip-row wrap">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" disabled={busy} onClick={() => submit(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {heard && <p className="heard">“{heard}”</p>}
        {busy && (
          <div className="ask-progress">
            <div className="spinner small-spinner" /> {progress || 'Working…'}
          </div>
        )}
        {reply && <p className="reply">{reply}</p>}
        {changes.length > 0 && (
          <ul className="changes">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
        {error && <div className="error-box"><p>{error}</p></div>}

        <div className="setup-actions">
          <button className="btn btn-ghost" onClick={onClose} data-close>
            {reply ? 'Done' : busy ? 'Close (keeps working)' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
