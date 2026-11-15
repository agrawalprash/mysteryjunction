import { useEffect, useRef, useState } from 'react';
import type { Candidate, DailyFeed } from '../engine/types.ts';
import { linkedTv, sendToTv } from '../lib/link.ts';
import type { NowPlaying } from '../lib/nowPlaying.ts';
import { formatDuration } from '../lib/format.ts';
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

/** The phone as a remote for Wander on the TV: what's playing, playback, the TV's set, and shortcuts. */
export function RemoteScreen({
  keys,
  onBack,
  openSearch,
  openDiagnose,
}: {
  keys: ApiKeys;
  onBack: () => void;
  openSearch: () => void;
  openDiagnose: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const openAsk = () => {
    setAsking(true);
    setOverlayCloser(() => setAsking(false));
  };
  const tv = linkedTv();
  const [state, setState] = useState<TvState | null>(null);
  const [feed, setFeed] = useState<DailyFeed | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
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

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setStatus('');
    try {
      await fn();
      if (ok) setStatus(ok);
      refresh();
    } catch (e) {
      setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const play = (v: Candidate) => run(() => sendToTv({ type: 'play', video: v }), `▶ Playing on the TV: ${v.title}`);
  const np = state?.nowPlaying;

  return (
    <div className="screen remote">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
        <div className="topbar-title">📺 TV remote</div>
      </header>

      {!tv && <div className="error-box"><p>No TV linked yet: Settings → Link to TV.</p></div>}
      {error && <div className="error-box"><p>{error}</p></div>}

      <section className="panel now-playing">
        {np ? (
          <>
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
            <div className="np-controls">
              <button className="btn btn-ghost" onClick={() => run(() => sendToTv({ type: 'player', action: 'back' }))}>
                ⏪ 10s
              </button>
              <button className="btn" onClick={() => run(() => sendToTv({ type: 'player', action: 'toggle' }))}>
                {np.playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button className="btn btn-ghost" onClick={() => run(() => sendToTv({ type: 'player', action: 'forward' }))}>
                10s ⏩
              </button>
              <button className="btn btn-ghost" onClick={() => run(() => sendToTv({ type: 'player', action: 'close' }))}>
                ✕ Close
              </button>
            </div>
          </>
        ) : (
          <p className="muted">{state ? 'Nothing playing on the TV. Pick something below.' : 'Connecting to the TV…'}</p>
        )}
      </section>

      <div className="remote-actions">
        <button className="btn btn-ghost" onClick={openAsk}>
          ✦ Ask (TV)
        </button>
        <button className="btn btn-ghost" onClick={openSearch}>
          🎤 Search on TV
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => run(() => sendToTv({ type: 'newSet' }), '✓ The TV is showing a new set.')}
          disabled={state?.setsLeft === 0}
        >
          New set{state ? ` (${state.setsLeft} left)` : ''}
        </button>
        <button className="btn btn-ghost" onClick={() => run(() => sendToTv({ type: 'home' }))}>
          ⌂ TV home
        </button>
        <button className="btn btn-ghost" onClick={openDiagnose}>
          🩺 Diagnose TV
        </button>
        <button
          className="btn btn-ghost"
          onClick={() =>
            run(async () => {
              setStatus('Checking for an update on the TV…');
              const r = (await sendToTv({ type: 'update' })) as { upToDate?: boolean; status?: string; version?: string };
              if (r.upToDate) throw new Error(`The TV already has the latest version (${r.version}).`);
              setStatus(
                r.status === 'needs-permission'
                  ? 'On the TV: allow installs from Wander (one time), then press Update TV again.'
                  : `On the TV: press Install with the remote to finish updating to ${r.version}.`,
              );
            })
          }
        >
          ⬆ Update TV{state ? ` (${state.version})` : ''}
        </button>
      </div>
      {status && <p className="planner-note">{status}</p>}

      {feed && (
        <main>
          <p className="planner-note">On the TV now: tap a video to play it there.</p>
          {feed.rows.map((row) => (
            <section key={row.id} className="row">
              <h2>{row.title}</h2>
              <div className="row-scroll">
                {row.items.map((v) => (
                  <VideoCard key={v.id} video={v} onOpen={play} />
                ))}
              </div>
            </section>
          ))}
          {feed.shorts.length > 0 && (
            <section className="row">
              <h2>Shorts</h2>
              <div className="row-scroll">
                {feed.shorts.map((v) => (
                  <VideoCard key={v.id} video={v} onOpen={play} variant="short" />
                ))}
              </div>
            </section>
          )}
        </main>
      )}
      {asking && (
        <AskSheet
          keys={keys}
          startWithVoice={false}
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
