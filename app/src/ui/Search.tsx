import { useState } from 'react';
import type { Candidate } from '../engine/types.ts';
import type { ApiKeys } from '../lib/keys.ts';
import { search } from '../lib/wander.ts';
import { VideoCard } from './VideoCard.tsx';

// Results are kept at module level so going back from a video keeps them.
let lastQuery = '';
let lastResults: Candidate[] = [];

export function Search({ keys, onBack, open }: { keys: ApiKeys; onBack: () => void; open: (v: Candidate) => void }) {
  const [q, setQ] = useState(lastQuery);
  const [results, setResults] = useState<Candidate[]>(lastResults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError('');
    try {
      const r = await search(q, keys);
      lastQuery = q;
      lastResults = r;
      setResults(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
        <form className="search-form" onSubmit={run}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search YouTube" enterKeyHint="search" />
        </form>
      </header>
      {busy && <div className="loading"><div className="spinner" /></div>}
      {error && <div className="error-box"><p>{error}</p></div>}
      <div className="list">
        {results.map((v) => (
          <VideoCard key={v.id} video={v} onOpen={open} variant="list" />
        ))}
      </div>
    </div>
  );
}
