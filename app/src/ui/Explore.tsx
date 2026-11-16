import { useEffect, useState } from 'react';
import type { Candidate } from '../engine/types.ts';
import type { ApiKeys } from '../lib/keys.ts';
import {
  exploreAsk,
  getSuggestions,
  noteOpenedFrom,
  placeMark,
  placesVisitedIn,
  placeVideos,
  recentPlaces,
  visitPlace,
  type ExploreResult,
  type PlaceMark,
} from '../lib/wander.ts';
import { claudeAuth } from '../lib/keys.ts';
import { AREAS, findPlace, levelOf, pathId, savedLevel, type MapLevel, type MapPlace } from '../lib/map.ts';
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

// ---------------------------------------------------------------- the Ask bar (on every Explore page)

function AskBar({
  keys,
  openResults,
  browsing,
  suggestions = [],
}: {
  keys: ApiKeys;
  openResults: () => void;
  /** The place on the map this page shows, so "more like this" means here. */
  browsing?: string[];
  suggestions?: Suggestion[];
}) {
  const tv = useTv();
  const [text, setText] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const view = useAskView();
  const here = browsing?.[browsing.length - 1];

  const submit = (said: string) => {
    const t = said.trim();
    if (!t || view.kind === 'busy') return;
    setText('');
    openResults();
    void runExplore((p) => exploreAsk(keys, t, p, browsing), t).catch(() => undefined);
  };
  const speak = async () => {
    setVoiceError('');
    try {
      const said = await listen(here ? `Ask about ${here}` : 'Ask for anything');
      if (said) submit(said);
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
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
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={here ? `Ask about ${here}, or anything else…` : 'Ask for anything: a topic, a mood, a change…'}
            enterKeyHint="send"
          />
        </form>
      </div>
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
      {view.kind !== 'idle' && !browsing && (
        <button className="btn btn-ghost last-ask" onClick={openResults}>
          {view.kind === 'busy' ? `Working on “${view.text}”…` : `Last ask: “${view.result.text}”`} →
        </button>
      )}
    </section>
  );
}

function Mark({ mark }: { mark: PlaceMark }) {
  return <span className={`place-mark mark-${mark}`} aria-label={mark === 'love' ? 'You love it' : mark === 'watched' ? 'Watched here' : 'Not been yet'} />;
}

// ---------------------------------------------------------------- the hub

export function ExploreHub({
  keys,
  onBack,
  openPlace,
  openResults,
}: {
  keys: ApiKeys;
  onBack: () => void;
  openPlace: (path: string[]) => void;
  openResults: () => void;
}) {
  const tv = useTv();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  useEffect(() => {
    if (keys.anthropic) getSuggestions(keys).then(setSuggestions).catch(() => undefined);
  }, [keys]);
  const recent = recentPlaces(4);

  return (
    <div className="screen explore">
      <Topbar title="Explore" onBack={onBack} />
      <AskBar keys={keys} openResults={openResults} suggestions={suggestions} />
      {tv && <p className="muted small explore-hint">Or hold the touchpad on your phone remote and say it.</p>}

      {recent.length > 0 && (
        <section className="explore-section">
          <h2>Pick up where you were</h2>
          <div className="recent-grid">
            {recent.map((p) => (
              <button key={pathId(p)} className="recent-tile" onClick={() => openPlace(p)}>
                <span className="recent-path">{p.slice(0, -1).join(' › ')}</span>
                <span className="recent-name">{p[p.length - 1]}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="explore-section">
        <h2>The map</h2>
        <div className="area-grid">
          {AREAS.map((a) => {
            const n = placesVisitedIn(a.path);
            const mark = placeMark(a.path);
            return (
              <button key={a.name} className="area-tile" onClick={() => openPlace(a.path)}>
                <span className="area-name">{a.name}</span>
                <span className={`area-sub${n || mark !== 'none' ? ' area-sub-on' : ''}`}>
                  {mark === 'love' ? '★ ' : ''}
                  {n ? `${n} visited` : mark !== 'none' ? 'Watched here' : 'Not yet'}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- one place on the map

export function MapPage({
  keys,
  path,
  onBack,
  goTo,
  open,
  openResults,
}: {
  keys: ApiKeys;
  path: string[];
  onBack: () => void;
  /** Jump to another place (a breadcrumb, a place inside, next door); [] is the hub. */
  goTo: (path: string[]) => void;
  open: (v: Candidate) => void;
  openResults: () => void;
}) {
  const tv = useTv();
  const place: MapPlace = findPlace(path);
  const [level, setLevel] = useState<MapLevel | null>(savedLevel(path));
  const [levelError, setLevelError] = useState('');
  const [videos, setVideos] = useState<Candidate[] | null>(null);
  const [videoNote, setVideoNote] = useState('');

  useEffect(() => {
    visitPlace(path);
    const auth = claudeAuth(keys);
    if (!level) {
      if (!auth) setLevelError('Drawing the map needs an Anthropic key.');
      else
        levelOf(auth, path)
          .then(setLevel)
          .catch((e) => setLevelError(e instanceof Error ? e.message : String(e)));
    }
    placeVideos(keys, place, setVideoNote)
      .then(setVideos)
      .catch((e) => {
        setVideos([]);
        setVideoNote(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setVideoNote((n) => (n.startsWith('Finding') ? '' : n)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On the TV, start on the first place to go deeper (or the first video at the end of the map).
  useEffect(() => {
    if (!tv) return;
    const t = window.setTimeout(() => {
      // Don't pull focus away once the viewer has moved somewhere on this page.
      if (document.activeElement?.closest('.map-page .place-tile, .map-page .card, .map-page .chip, .map-page input')) return;
      focusFirst(document.querySelector('.map-page .place-tile') ? '.map-page .place-tile' : '.map-page .card');
    }, 120);
    return () => clearTimeout(t);
  }, [tv, level, videos]);

  const parent = path.length > 1 ? savedLevel(path.slice(0, -1)) : null;
  const siblings = (parent?.children ?? []).filter((c) => pathId(c.path) !== pathId(path)).slice(0, 4);
  const elsewhere = level?.elsewhere ?? [];
  const deep = !!level && level.children.length <= 4;
  const watch = (v: Candidate) => {
    noteOpenedFrom(v.id, path);
    open(v);
  };

  return (
    <div className="screen explore map-page">
      <Topbar title={place.name} onBack={onBack} />
      <nav className="crumbs" aria-label="Where you are">
        <button className="crumb" onClick={() => goTo([])}>
          Map
        </button>
        {path.slice(0, -1).map((p, i) => (
          <span key={p} className="crumb-wrap">
            <span aria-hidden="true">›</span>
            <button className="crumb" onClick={() => goTo(path.slice(0, i + 1))}>
              {p}
            </button>
          </span>
        ))}
      </nav>
      <AskBar keys={keys} openResults={openResults} browsing={path} />
      {place.desc && <p className="map-desc">{place.desc}</p>}

      <div className={`map-body${deep ? ' map-deep' : ''}`}>
        <section className="map-watch">
          <h2>Watch from here</h2>
          {videos === null && (
            <div className="ask-progress">
              <div className="spinner small-spinner" /> {videoNote || 'Looking for videos…'}
            </div>
          )}
          {videos?.length === 0 && <p className="muted small">{videoNote || 'Nothing here yet. Try a place inside, or ask.'}</p>}
          {!!videos?.length && (
            <div className="watch-grid">
              {videos.map((v) => (
                <VideoCard key={v.id} video={v} onOpen={watch} />
              ))}
            </div>
          )}
        </section>

        <section className="map-deeper">
          <h2>
            Go deeper{level ? <span className="muted"> · {level.children.length} places</span> : null}
          </h2>
          {!level && !levelError && (
            <div className="ask-progress">
              <div className="spinner small-spinner" /> Claude is drawing this part of the map…
            </div>
          )}
          {levelError && <p className="small error-text">{levelError}</p>}
          {level && (
            <div className="place-grid">
              {level.children.map((c) => (
                <button key={c.name} className="place-tile" onClick={() => goTo(c.path)}>
                  <Mark mark={placeMark(c.path)} />
                  <span className="place-text">
                    <span className="place-name">{c.name}</span>
                    <span className="place-desc">{c.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {siblings.length + elsewhere.length > 0 && (
            <>
              <h2>Next door</h2>
              <div className="chip-row wrap">
                {siblings.map((c) => (
                  <button key={c.name} className="chip" onClick={() => goTo(c.path)}>
                    {c.name}
                  </button>
                ))}
                {elsewhere.map((c) => (
                  <button key={pathId(c.path)} className="chip chip-world" title={c.path.join(' › ')} onClick={() => goTo(c.path)}>
                    {c.name} ↗
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
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
