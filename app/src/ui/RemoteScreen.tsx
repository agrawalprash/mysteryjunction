import { useEffect, useRef, useState } from 'react';
import type { Candidate, DailyFeed } from '../engine/types.ts';
import { linkedTv, sendToTv, type LinkMessage } from '../lib/link.ts';
import type { NowPlaying } from '../lib/nowPlaying.ts';
import { formatDuration } from '../lib/format.ts';
import { listen } from '../lib/voice.ts';
import { VideoCard } from './VideoCard.tsx';
import { AskSheet } from './AskSheet.tsx';
import type { ApiKeys } from '../lib/keys.ts';
import { setOverlayCloser } from '../lib/overlay.ts';

interface TvState {
  version: string;
  screen: string;
  nowPlaying: NowPlaying | null;
  setsLeft: number;
  feedVersion: number;
  feed?: DailyFeed | null;
}

type Key = Extract<LinkMessage, { type: 'key' }>['key'];

/** A short buzz, like a physical remote's click. */
function tick() {
  try {
    navigator.vibrate?.(12);
  } catch {
    /* no vibration on this device */
  }
}

/**
 * Remote mode: the phone as a Google TV–style remote for Wander on the TV.
 * The big mic searches by voice straight onto the TV; the D-pad drives the TV app.
 */
export function RemoteScreen({
  keys,
  onBack,
  openDiagnose,
}: {
  keys: ApiKeys;
  onBack: () => void;
  openDiagnose: () => void;
}) {
  const tv = linkedTv();
  const [state, setState] = useState<TvState | null>(null);
  const [feed, setFeed] = useState<DailyFeed | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [listening, setListening] = useState(false);
  const [asking, setAsking] = useState(false);
  const [showSet, setShowSet] = useState(false);
  const feedVersion = useRef(-1);

  const refresh = async () => {
    try {
      const s = (await sendToTv({ type: 'tvState', feedVersion: feedVersion.current })) as TvState;
      setState(s);
      if (s.feed !== undefined) {
        feedVersion.current = s.feedVersion;
        setFeed(s.feed ?? null);
      }
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (m: LinkMessage, ok?: string) => {
    try {
      await sendToTv(m);
      if (ok) setStatus(ok);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const key = (k: Key) => {
    tick();
    void send({ type: 'key', key: k });
  };

  // The big button: speak, and it's searched on the TV straight away.
  const voiceSearch = async () => {
    if (listening) return;
    tick();
    setListening(true);
    setStatus('');
    try {
      const said = (await listen('What do you want to watch?')).trim();
      if (said) {
        setStatus(`🔎 “${said}” → searching on the TV…`);
        const r = (await sendToTv({ type: 'search', q: said })) as { count?: number };
        setStatus(`📺 ${r.count ?? ''} results for “${said}” on the TV. Use the arrows to pick one.`);
      }
    } catch (e) {
      setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setListening(false);
    }
  };

  const np = state?.nowPlaying;

  return (
    <div className="screen remote">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back to Wander on the phone" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
        <div className="topbar-title">📺 TV remote</div>
        <span className={`link-dot${error ? ' link-dot-bad' : state ? ' link-dot-ok' : ''}`} title={error || 'Connected'} />
      </header>

      {!tv && <div className="error-box"><p>No TV linked yet: Settings → Link to TV.</p></div>}
      {error && <div className="error-box"><p>{error}</p></div>}

      <div className="remote-mic-wrap">
        <button className={`remote-mic${listening ? ' remote-mic-on' : ''}`} onPointerDown={voiceSearch} aria-label="Search by voice on the TV">
          🎤
        </button>
        <div className="muted small">{listening ? 'Listening…' : 'Press and say what to watch'}</div>
      </div>
      {status && <p className="planner-note remote-status">{status}</p>}

      <div className="dpad">
        <button className="dpad-btn dpad-up" aria-label="Up" onClick={() => key('ArrowUp')}>▲</button>
        <button className="dpad-btn dpad-left" aria-label="Left" onClick={() => key('ArrowLeft')}>◀</button>
        <button className="dpad-ok" aria-label="OK" onClick={() => key('Enter')}>OK</button>
        <button className="dpad-btn dpad-right" aria-label="Right" onClick={() => key('ArrowRight')}>▶</button>
        <button className="dpad-btn dpad-down" aria-label="Down" onClick={() => key('ArrowDown')}>▼</button>
      </div>

      <div className="remote-row">
        <button className="btn btn-ghost" onClick={() => key('Back')}>↩ Back</button>
        <button className="btn btn-ghost" onClick={() => key('Home')}>⌂ Home</button>
        <button className="btn btn-ghost" onClick={() => (tick(), send({ type: 'newSet' }, '↻ New set on the TV.'))}>↻ New set</button>
      </div>

      <div className="remote-row">
        <button className="btn btn-ghost" onClick={() => (tick(), send({ type: 'player', action: 'back' }))}>⏪ 10s</button>
        <button className="btn" onClick={() => (tick(), send({ type: 'player', action: 'toggle' }))}>{np?.playing ? '⏸' : '▶'}</button>
        <button className="btn btn-ghost" onClick={() => (tick(), send({ type: 'player', action: 'forward' }))}>10s ⏩</button>
      </div>

      {np && (
        <section className="panel now-playing">
          <div className="np-row">
            <img src={np.thumb} alt="" />
            <div>
              <div className="card-title">{np.title}</div>
              <div className="muted small">
                {np.channelTitle} · {formatDuration(Math.round(np.time))} / {formatDuration(Math.round(np.duration))}
              </div>
            </div>
          </div>
          <div className="np-progress">
            <span style={{ width: `${np.duration ? Math.min(100, (np.time / np.duration) * 100) : 0}%` }} />
          </div>
        </section>
      )}

      <div className="remote-actions">
        <button
          className="btn btn-ghost"
          onClick={() => {
            setAsking(true);
            setOverlayCloser(() => setAsking(false));
          }}
        >
          ✦ Ask (TV)
        </button>
        <button className="btn btn-ghost" onClick={() => setShowSet((v) => !v)}>
          {showSet ? 'Hide' : 'Show'} the TV’s set
        </button>
        <button className="btn btn-ghost" onClick={openDiagnose}>
          🩺 Diagnose TV
        </button>
        <button
          className="btn btn-ghost"
          onClick={async () => {
            setStatus('Checking for an update on the TV…');
            try {
              const r = (await sendToTv({ type: 'update' })) as { upToDate?: boolean; status?: string; version?: string };
              setStatus(
                r.upToDate
                  ? `The TV already has the latest version (${r.version}).`
                  : r.status === 'needs-permission'
                    ? 'On the TV: allow installs from Wander (one time), then press Update TV again.'
                    : `On the TV: press Install with the remote to finish updating to ${r.version}.`,
              );
            } catch (e) {
              setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
            }
          }}
        >
          ⬆ Update TV{state ? ` (${state.version})` : ''}
        </button>
      </div>

      {showSet && feed && (
        <main>
          <p className="planner-note">Tap a video to play it on the TV.</p>
          {feed.rows.map((row) => (
            <section key={row.id} className="row">
              <h2>{row.title}</h2>
              <div className="row-scroll">
                {row.items.map((v: Candidate) => (
                  <VideoCard key={v.id} video={v} onOpen={(c) => send({ type: 'play', video: c }, `▶ Playing on the TV: ${c.title}`)} />
                ))}
              </div>
            </section>
          ))}
        </main>
      )}

      {asking && (
        <AskSheet
          keys={keys}
          startWithVoice
          onClose={() => {
            setAsking(false);
            setOverlayCloser(null);
            refresh();
          }}
          onFeed={() => refresh()}
        />
      )}
    </div>
  );
}
