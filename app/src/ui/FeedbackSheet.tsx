import { useEffect, useRef, useState } from 'react';
import type { ApiKeys } from '../lib/keys.ts';
import { postFeedback, thread, type ThreadComment } from '../lib/feedback.ts';
import { listen } from '../lib/voice.ts';
import { focusFirst } from '../lib/spatialNav.ts';
import { useTv } from './App.tsx';

/** Say or type feedback about the app itself; it goes to Claude (the one building Wander). */
export function FeedbackSheet({ keys, onClose }: { keys: ApiKeys; onClose: () => void }) {
  const tv = useTv();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [comments, setComments] = useState<ThreadComment[]>([]);
  const mounted = useRef(true);

  const refresh = () =>
    thread()
      .then((c) => mounted.current && setComments(c))
      .catch(() => undefined);

  useEffect(() => {
    refresh();
    if (tv) window.setTimeout(() => focusFirst(), 30);
    const t = window.setInterval(refresh, 60_000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (said: string) => {
    const t = said.trim();
    if (!t || busy) return;
    if (!keys.github) {
      setError('Add a GitHub token first (Settings → Feedback to Claude).');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await postFeedback(keys.github, t, tv ? 'TV' : 'phone');
      setText('');
      setStatus('✓ Sent. Claude will reply here, and a new version pops up when it’s ready.');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const speak = async () => {
    setError('');
    try {
      const said = await listen('What should change in Wander?');
      if (said) setText((prev) => (prev ? `${prev} ${said}` : said));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(tv ? `Voice isn’t working on this TV (${msg}). Send feedback from Wander on your phone instead.` : msg);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Feedback">
        <h2>💬 Feedback to Claude</h2>
        <p className="muted small">
          Tell the Claude that builds Wander what to fix or add. Speak, check the text, then send. Your note goes to the app’s GitHub feedback inbox
          with your app version and screen size.
        </p>
        <div className="ask-row">
          <button className="btn mic-btn" onClick={speak} disabled={busy} data-autofocus>
            🎤 {tv ? 'Speak' : 'Talk'}
          </button>
        </div>
        <textarea className="feedback-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="…or type here" disabled={busy} />
        <div className="setup-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn" onClick={() => send(text)} disabled={busy || !text.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
        {status && <p className="small">{status}</p>}
        {error && <div className="error-box"><p>{error}</p></div>}
        {comments.length > 0 && (
          <>
            <h3 className="thread-title">Recent conversation</h3>
            <ul className="thread">
              {comments.map((c, i) => (
                <li key={i} className={c.fromClaude ? 'from-claude' : 'from-you'}>
                  <span className="tag">{c.fromClaude ? 'Claude' : 'You'}</span> <span className="muted small">{c.at.slice(0, 16).replace('T', ' ')}</span>
                  <p>{c.body}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
