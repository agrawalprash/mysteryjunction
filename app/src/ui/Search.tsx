import { useEffect, useRef, useState } from 'react';
import type { Candidate } from '../engine/types.ts';
import type { ApiKeys } from '../lib/keys.ts';
import { search } from '../lib/wander.ts';
import { listen } from '../lib/voice.ts';
import { linkedTv, sendToTv } from '../lib/link.ts';
import { VideoCard } from './VideoCard.tsx';
import { useTv } from './App.tsx';

// Results are kept at module level so going back from a video keeps them.
let lastQuery = '';
let lastResults: Candidate[] = [];

/** Show results that were fetched elsewhere (a search sent from the phone). */
export function preloadSearch(q: string, results: Candidate[]) {
  lastQuery = q;
  lastResults = results;
}

export function Search({
  keys,
  onBack,
  open,
  initialQuery,
  initialTarget,
}: {
  keys: ApiKeys;
  onBack: () => void;
  open: (v: Candidate) => void;
  /** Set when the search came from somewhere else (e.g. spoken on the phone for the TV). */
  initialQuery?: string;
  /** Opened from the TV remote screen: results go to the TV by default. */
  initialTarget?: 'here' | 'tv';
}) {
  const tv = useTv();
  const tvLink = !tv ? linkedTv() : null;
  const [target, setTarget] = useState<'here' | 'tv'>(tvLink && initialTarget === 'tv' ? 'tv' : 'here');
  const [q, setQ] = useState(initialQuery ?? lastQuery);
  const [results, setResults] = useState<Candidate[]>(initialQuery ? [] : lastResults);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const ran = useRef(false);

  const runQuery = async (query: string) => {
    const text = query.trim();
    if (!text) return;
    setQ(text);
    setBusy(true);
    setError('');
    setStatus('');
    try {
      if (target === 'tv') {
        const r = await sendToTv({ type: 'search', q: text });
        setStatus(`📺 Showing ${r.count ?? 'the'} results for “${text}” on the TV.`);
        return;
      }
      const r = await search(text, keys);
      lastQuery = text;
      lastResults = r;
      setResults(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialQuery && !ran.current) {
      ran.current = true;
      runQuery(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const speak = async () => {
    setError('');
    try {
      const said = await listen('What do you want to watch?');
      if (said) await runQuery(said);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        tv
          ? `Voice isn’t working on this TV (${msg}). Speak into Wander on your phone instead: Search → 📺 TV.`
          : msg,
      );
    }
  };

  return (
    <div className="screen">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            runQuery(q);
          }}
        >
          <input autoFocus={!tv} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search YouTube" enterKeyHint="search" />
        </form>
        <button className="icon-btn mic-icon" aria-label="Search by voice" onClick={speak} disabled={busy} data-autofocus>
          🎤
        </button>
      </header>
      {tvLink && (
        <div className="target-row search-target">
          <span className="muted small">Show results on</span>
          <button className={`chip${target === 'here' ? ' chip-on' : ''}`} onClick={() => setTarget('here')}>
            This phone
          </button>
          <button className={`chip${target === 'tv' ? ' chip-on' : ''}`} onClick={() => setTarget('tv')}>
            📺 TV
          </button>
        </div>
      )}
      {busy && (
        <div className="loading">
          <div className="spinner" />
        </div>
      )}
      {status && <p className="planner-note">{status}</p>}
      {error && (
        <div className="error-box">
          <p>{error}</p>
        </div>
      )}
      <div className="list">
        {results.map((v) => (
          <VideoCard key={v.id} video={v} onOpen={open} variant="list" />
        ))}
      </div>
    </div>
  );
}
