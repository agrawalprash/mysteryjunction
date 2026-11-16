import { useEffect, useState } from 'react';
import type { Candidate } from '../engine/types.ts';
import type { ApiKeys } from '../lib/keys.ts';
import { exploreAsk, exploreWorlds, getSuggestions, worldShelves, type ExploreResult, type WorldTile } from '../lib/wander.ts';
import type { Suggestion } from '../lib/claude.ts';
import { listen } from '../lib/voice.ts';
import { VideoCard } from './VideoCard.tsx';
import { TimeChip } from './TimeChip.tsx';
import { useTv } from './App.tsx';
import { focusFirst } from '../lib/spatialNav.ts';

// Explore has three pages, and only one thing changes at a time:
//   the hub (ask + worlds as doors) -> a world's own page -> back
//   the hub -> an Ask's results page -> back

// ---------------------------------------------------------------- the latest Ask, shared with the TV link

type AskView = { kind: 'idle' } | { kind: 'busy'; text: string; progress: string } | { kind: 'done'; result: ExploreResult; error?: string };
let askView: AskView = { kind: 'idle' };
const listeners = new Set<() => void>();
function setAskView(v: AskView) {
  askView = v;
  listeners.forEach((fn) => fn());
}
function useAskView() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return askView;
}

/** Run an ask from anywhere (the hub, or the phone remote via the TV) and show it on the results page. */
export async function runExplore(run: (onProgress: (m: string) => void) => Promise<ExploreResult>, text: string): Promise<ExploreResult> {
  setAskView({ kind: 'busy', text, progress: '' });
  try {
    const result = await run((progress) => setAskView({ kind: 'busy', text, progress }));
    setAskView({ kind: 'done', result });
    return result;
  } catch (e) {
    setAskView({ kind: 'done', result: { text, poolHits: [], results: [], focus: [] }, error: e instanceof Error ? e.message : String(e) });
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

function Topbar({ title, subtitle, onBack }: { title: string; subtitle?: string; onBack: () => void }) {
  return (
    <header className="topbar">
      <button className="icon-btn" aria-label="Back" onClick={onBack}>
        <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
      </button>
      <div className="topbar-title">
        {title}
        {subtitle && <div className="topbar-sub">{subtitle}</div>}
      </div>
      <div className="topbar-actions">
        <TimeChip />
      </div>
    </header>
  );
}

function Tiles({ tiles, edge, onPick }: { tiles: WorldTile[]; edge?: boolean; onPick: (w: WorldTile) => void }) {
  return (
    <div className="world-strip">
      {tiles.map((w) => (
        <button key={w.concept} className={`world-tile${edge ? ' world-edge' : ''}`} onClick={() => onPick(w)}>
          <span className="world-thumb">{w.thumb && <img src={w.thumb} alt="" loading="lazy" />}</span>
          <span className="world-name">{cap(w.concept)}</span>
          <span className="world-sub">{edge && w.via ? `next to ${w.via}` : `${w.count} videos`}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the hub

export function ExploreHub({
  keys,
  onBack,
  openWorld,
  openResults,
}: {
  keys: ApiKeys;
  onBack: () => void;
  openWorld: (concept: string, via?: string) => void;
  openResults: () => void;
}) {
  const tv = useTv();
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [voiceError, setVoiceError] = useState('');
  const worlds = exploreWorlds();
  const view = useAskView();

  useEffect(() => {
    if (keys.anthropic) getSuggestions(keys).then(setSuggestions).catch(() => undefined);
  }, [keys]);

  const submit = (said: string) => {
    const t = said.trim();
    if (!t || view.kind === 'busy') return;
    setText('');
    openResults();
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

  const liked = worlds.yours.some((w) => w.affinity > 0);
  return (
    <div className="screen explore">
      <Topbar title="Explore" onBack={onBack} />

      <section className="explore-ask">
        <div className="ask-row">
          {!tv && (
            <button className="btn mic-btn" aria-label="Ask by voice" onClick={speak}>
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
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask for anything: a topic, a mood, a change…" enterKeyHint="send" />
          </form>
        </div>
        {tv && <p className="muted small">Or hold the touchpad on your phone remote and say it.</p>}
        {voiceError && <p className="small error-text">{voiceError}</p>}
        {suggestions.length > 0 && (
          <div className="chip-row wrap">
            {suggestions.slice(0, 6).map((s) => (
              <button key={s.label} className={`chip${s.kind === 'new' ? ' chip-new' : s.kind === 'mood' ? ' chip-mood' : ''}`} onClick={() => submit(s.label)}>
                {s.label}
              </button>
            ))}
          </div>
        )}
        {view.kind !== 'idle' && (
          <button className="btn btn-ghost last-ask" onClick={openResults}>
            {view.kind === 'busy' ? `Working on “${view.text}”…` : `Last ask: “${view.result.text}”`} →
          </button>
        )}
      </section>

      <section className="explore-worlds">
        <h2>{liked ? 'Your worlds' : 'Worlds to start with'}</h2>
        {worlds.yours.length === 0 ? (
          <p className="muted small">Worlds appear as Claude describes the videos waiting for you. Give it a minute.</p>
        ) : (
          <Tiles tiles={worlds.yours} onPick={(w) => openWorld(w.concept)} />
        )}
        {worlds.edges.length > 0 && (
          <>
            <h2>Just past the edge</h2>
            <p className="muted small">Places you haven’t been yet that keep turning up next to yours.</p>
            <Tiles tiles={worlds.edges} edge onPick={(w) => openWorld(w.concept, w.via)} />
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- one world

export function WorldPage({
  concept,
  via,
  onBack,
  open,
  openWorld,
}: {
  concept: string;
  via?: string;
  onBack: () => void;
  open: (v: Candidate) => void;
  openWorld: (concept: string) => void;
}) {
  const w = worldShelves(concept);
  return (
    <div className="screen explore world-page">
      <Topbar title={cap(concept)} subtitle={via ? `Next to ${via} · ${w.count} videos` : `${w.count} videos waiting`} onBack={onBack} />
      {w.count === 0 && <p className="muted planner-note">Nothing left here right now. More arrive as Wander tops up.</p>}
      <Row title="Best here" items={w.best} open={open} />
      <Row title="Short ones" items={w.short} open={open} />
      <Row title="Go deeper" items={w.deeper} open={open} />
      {w.nearby.length > 0 && (
        <section className="explore-worlds">
          <h2>Worlds nearby</h2>
          <div className="chip-row wrap">
            {w.nearby.map((c) => (
              <button key={c} className="chip chip-world" onClick={() => openWorld(c)}>
                {cap(c)} →
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- an Ask's results

export function ResultsPage({ onBack, goHome, open }: { onBack: () => void; goHome: () => void; open: (v: Candidate) => void }) {
  const view = useAskView();
  const tv = useTv();
  // On the TV, land on the first result when it arrives.
  useEffect(() => {
    if (tv && view.kind === 'done') window.setTimeout(() => focusFirst('.results-page .row .card'), 80);
  }, [tv, view.kind]);
  return (
    <div className="screen explore results-page">
      <Topbar title={view.kind === 'idle' ? 'Ask' : `“${view.kind === 'busy' ? view.text : view.result.text}”`} onBack={onBack} />
      <div className="explore-status">
        {view.kind === 'busy' && (
          <div className="ask-progress">
            <div className="spinner small-spinner" /> {view.progress || 'Claude is thinking…'}
          </div>
        )}
        {view.kind === 'done' && (
          <>
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
            {view.result.newSet && (
              <button className="btn" onClick={goHome}>
                See the new set on Home
              </button>
            )}
          </>
        )}
      </div>
      {view.kind === 'done' && (
        <>
          <Row title="Because you asked" items={view.result.focus} open={open} />
          <Row title="Already waiting for you" items={view.result.poolHits} open={open} />
          <Row title="From YouTube" items={view.result.results} open={open} />
          {view.result.focus.length + view.result.poolHits.length + view.result.results.length === 0 && !view.error && !view.result.newSet && (
            <p className="muted planner-note">Nothing to show for that. Try saying it another way.</p>
          )}
        </>
      )}
    </div>
  );
}
