import { useEffect, useRef, useState } from 'react';
import type { Candidate } from '../engine/types.ts';
import type { World } from '../engine/worlds.ts';
import type { ApiKeys } from '../lib/keys.ts';
import { exploreAsk, exploreWorlds, getSuggestions, worldItems, type ExploreResult } from '../lib/wander.ts';
import type { Suggestion } from '../lib/claude.ts';
import { listen } from '../lib/voice.ts';
import { focusFirst } from '../lib/spatialNav.ts';
import { VideoCard } from './VideoCard.tsx';
import { useTv } from './App.tsx';

// What Explore is showing lives here, so it survives opening a video and can be
// filled from elsewhere (something said into the phone remote for the TV).
type View = { kind: 'idle' } | { kind: 'busy'; text: string; progress: string } | { kind: 'result'; result: ExploreResult; error?: string } | { kind: 'world'; world: World };
let view: View = { kind: 'idle' };
const listeners = new Set<() => void>();
function setView(v: View) {
  view = v;
  listeners.forEach((fn) => fn());
}

/** Run an ask from anywhere (e.g. the TV, for the phone remote) and show it in Explore. */
export async function runExplore(run: (onProgress: (m: string) => void) => Promise<ExploreResult>, text: string): Promise<ExploreResult> {
  setView({ kind: 'busy', text, progress: '' });
  try {
    const result = await run((progress) => setView({ kind: 'busy', text, progress }));
    setView({ kind: 'result', result });
    return result;
  } catch (e) {
    setView({ kind: 'result', result: { text, poolHits: [], results: [], focus: [] }, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Row({ title, subtitle, items, open }: { title: string; subtitle?: string; items: Candidate[]; open: (v: Candidate) => void }) {
  if (!items.length) return null;
  return (
    <section className="row">
      <h2>{title}</h2>
      {subtitle && <p className="row-sub">{subtitle}</p>}
      <div className="row-scroll">
        {items.map((v) => (
          <VideoCard key={v.id} video={v} onOpen={open} />
        ))}
      </div>
    </section>
  );
}

/** Explore: ask for anything, and wander through worlds that grow from what you watch. */
export function Explore({ keys, onBack, goHome, open }: { keys: ApiKeys; onBack: () => void; goHome: () => void; open: (v: Candidate) => void }) {
  const tv = useTv();
  const [, rerender] = useState(0);
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [voiceError, setVoiceError] = useState('');
  const worlds = exploreWorlds();
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (keys.anthropic) getSuggestions(keys).then(setSuggestions).catch(() => undefined);
  }, [keys]);

  // When something new shows up, bring it into view (and focus it on the TV).
  const shownKey = view.kind === 'result' ? view.result.text : view.kind === 'world' ? view.world.concept : '';
  useEffect(() => {
    if (!shownKey) return;
    resultRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (tv) window.setTimeout(() => focusFirst('.explore-results .card'), 120);
  }, [shownKey, tv]);

  const submit = (said: string) => {
    const t = said.trim();
    if (!t || view.kind === 'busy') return;
    setText('');
    void runExplore((p) => exploreAsk(keys, t, p), t).catch(() => undefined);
  };

  const speak = async () => {
    setVoiceError('');
    try {
      const said = await listen('Ask for anything');
      if (said) submit(said);
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = view.kind === 'busy';

  return (
    <div className="screen explore">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
        <div className="topbar-title">Explore</div>
      </header>

      <section className="explore-ask">
        <div className="ask-row">
          {!tv && (
            <button className="btn mic-btn" onClick={speak} disabled={busy}>
              🎤
            </button>
          )}
          <form
            className="ask-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit(text);
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask for anything: a topic, a mood, a change…" enterKeyHint="send" disabled={busy} />
          </form>
        </div>
        {tv && <p className="muted small">Or hold the touchpad on your phone remote and say it.</p>}
        {voiceError && <p className="small error-text">{voiceError}</p>}
        {view.kind === 'idle' && suggestions.length > 0 && (
          <div className="chip-row wrap">
            {suggestions.slice(0, 8).map((s) => (
              <button key={s.label} className={`chip${s.kind === 'new' ? ' chip-new' : s.kind === 'mood' ? ' chip-mood' : ''}`} onClick={() => submit(s.label)}>
                {s.label}
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="explore-results" ref={resultRef}>
        {view.kind === 'busy' && (
          <div className="explore-status">
            <p className="heard">“{view.text}”</p>
            <div className="ask-progress">
              <div className="spinner small-spinner" /> {view.progress || 'Claude is thinking…'}
            </div>
          </div>
        )}
        {view.kind === 'result' && (
          <>
            <div className="explore-status">
              <p className="heard">“{view.result.text}”</p>
              {view.result.reply && <p className="reply">{view.result.reply}</p>}
              {!!view.result.changes?.length && (
                <ul className="changes">
                  {view.result.changes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
              {(view.error || view.result.notice) && (
                <div className="error-box">
                  <p>{view.error || view.result.notice}</p>
                </div>
              )}
              <div className="end-actions left">
                {view.result.newSet && (
                  <button className="btn" onClick={goHome}>
                    See the new set on Home
                  </button>
                )}
                <button className="btn btn-ghost" onClick={() => setView({ kind: 'idle' })}>
                  Clear
                </button>
              </div>
            </div>
            <Row title="Because you asked" items={view.result.focus} open={open} />
            <Row title="Already waiting for you" items={view.result.poolHits} open={open} />
            <Row title="From YouTube" items={view.result.results} open={open} />
          </>
        )}
        {view.kind === 'world' && (
          <Row
            title={cap(view.world.concept)}
            subtitle={view.world.via ? `Next to ${view.world.via}` : `${view.world.count} videos waiting`}
            items={worldItems(view.world.concept)}
            open={open}
          />
        )}
      </div>

      <section className="explore-worlds">
        <h2>{worlds.yours.some((w) => w.affinity > 0) ? 'Your worlds' : 'Worlds to start with'}</h2>
        {worlds.yours.length === 0 && <p className="muted small">Worlds appear as Claude describes the videos in your pool. Give it a minute.</p>}
        <div className="world-grid">
          {worlds.yours.map((w) => (
            <button
              key={w.concept}
              className={`world-tile${view.kind === 'world' && view.world.concept === w.concept ? ' world-on' : ''}`}
              onClick={() => setView({ kind: 'world', world: w })}
            >
              <span className="world-name">{cap(w.concept)}</span>
              <span className="muted small">{w.count} videos</span>
            </button>
          ))}
        </div>
        {worlds.edges.length > 0 && (
          <>
            <h2>Just past the edge</h2>
            <div className="world-grid">
              {worlds.edges.map((w) => (
                <button
                  key={w.concept}
                  className={`world-tile world-edge${view.kind === 'world' && view.world.concept === w.concept ? ' world-on' : ''}`}
                  onClick={() => setView({ kind: 'world', world: w })}
                >
                  <span className="world-name">{cap(w.concept)}</span>
                  <span className="muted small">next to {w.via}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
