import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candidate, DailyFeed } from '../engine/types.ts';
import { linkedTv, sendToTv, type LinkMessage } from '../lib/link.ts';
import type { NowPlaying } from '../lib/nowPlaying.ts';
import { formatDuration } from '../lib/format.ts';
import { holdCancel, holdStart, holdStop } from '../lib/voice.ts';
import { createGestures } from '../lib/gestures.ts';
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
type VoiceMode = 'search' | 'ask';

/** A short buzz, like a physical remote's click. */
function tick(ms = 12) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* no vibration on this device */
  }
}

/**
 * Remote mode: the phone as a gesture remote for Wander on the TV.
 * Swipe = arrows, tap = OK, press and hold = voice search (sent on release).
 */
export function RemoteScreen({ keys, onBack, openDiagnose }: { keys: ApiKeys; onBack: () => void; openDiagnose: () => void }) {
  const tv = linkedTv();
  const [state, setState] = useState<TvState | null>(null);
  const [feed, setFeed] = useState<DailyFeed | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [voice, setVoice] = useState<{ mode: VoiceMode; text: string; ready: boolean } | null>(null);
  const [asking, setAsking] = useState(false);
  const [more, setMore] = useState(false);
  const [flash, setFlash] = useState('');
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
    setFlash(k);
    window.setTimeout(() => setFlash(''), 160);
    void send({ type: 'key', key: k });
  };

  // ---------------------------------------------------------------- hold to talk

  const starting = useRef<Promise<(() => void) | null> | null>(null);
  const modeRef = useRef<VoiceMode>('search');

  const startVoice = (mode: VoiceMode) => {
    tick(25);
    modeRef.current = mode;
    setStatus('');
    setVoice({ mode, text: '', ready: false });
    starting.current = holdStart(
      (text) => setVoice((v) => (v ? { ...v, text } : v)),
      () => setVoice((v) => (v ? { ...v, ready: true } : v)),
    ).catch((e) => {
      setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
      setVoice(null);
      return null;
    });
  };

  const endVoice = async () => {
    const cleanup = await starting.current;
    starting.current = null;
    if (!cleanup) return;
    tick(18);
    const mode = modeRef.current;
    try {
      const said = (await holdStop()).trim();
      setVoice(null);
      if (!said) return;
      if (mode === 'search') {
        setStatus(`🔎 “${said}” → searching on the TV…`);
        const r = (await sendToTv({ type: 'search', q: said })) as { count?: number };
        setStatus(`📺 ${r.count ?? ''} results for “${said}”. Swipe to pick, tap to play.`);
      } else {
        setStatus(`✦ “${said}” → asking Claude on the TV…`);
        const r = (await sendToTv({ type: 'ask', text: said })) as { reply?: string; changes?: string[] };
        setStatus(`✦ ${r.reply ?? 'Done.'}${r.changes?.length ? ` (${r.changes.join(', ')})` : ''}`);
      }
    } catch (e) {
      setVoice(null);
      setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      cleanup();
    }
  };

  useEffect(
    () => () => {
      holdCancel();
    },
    [],
  );

  // ---------------------------------------------------------------- the touch pad

  const gestures = useMemo(
    () =>
      createGestures({
        step: (d) => key(d),
        tap: () => key('Enter'),
        holdStart: () => startVoice('search'),
        holdEnd: () => void endVoice(),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // A button that's an Ask on tap (opens the panel) and hold-to-talk to Claude on long press.
  const askHold = useRef<{ timer?: number; held: boolean }>({ held: false });

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

      <div className="remote-status-line">
        {voice ? (
          <span className="voice-live">
            {voice.mode === 'ask' ? '✦ ' : '🎤 '}
            {voice.text || (voice.ready ? 'Listening… speak now' : 'Starting the mic…')}
          </span>
        ) : status ? (
          <span>{status}</span>
        ) : np ? (
          <span className="muted">
            ▶ {np.title} · {formatDuration(Math.round(np.time))} / {formatDuration(Math.round(np.duration))}
          </span>
        ) : (
          <span className="muted">Wander on the TV</span>
        )}
      </div>

      <div
        className={`touchpad${voice ? ' touchpad-listening' : ''}${flash ? ` flash-${flash}` : ''}`}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          gestures.down(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => gestures.move(e.clientX, e.clientY)}
        onPointerUp={() => gestures.up()}
        onPointerCancel={() => gestures.cancel()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {voice ? (
          <div className="touchpad-voice">
            <div className="touchpad-mic">{voice.mode === 'ask' ? '✦' : '🎤'}</div>
            <div>Release to {voice.mode === 'ask' ? 'ask Claude' : 'search'}</div>
          </div>
        ) : (
          <div className="touchpad-hint">
            <div className="touchpad-mic">🎤</div>
            <div>
              <b>Press and hold</b> to search by voice
            </div>
            <div className="muted small">Swipe to move · Tap for OK</div>
          </div>
        )}
      </div>

      <div className="remote-row">
        <button className="btn btn-ghost" onClick={() => key('Back')}>↩ Back</button>
        <button
          className="btn ask-hold"
          onPointerDown={() => {
            askHold.current.held = false;
            askHold.current.timer = window.setTimeout(() => {
              askHold.current.held = true;
              startVoice('ask');
            }, 300);
          }}
          onPointerUp={() => {
            clearTimeout(askHold.current.timer);
            if (askHold.current.held) void endVoice();
            else {
              setAsking(true);
              setOverlayCloser(() => setAsking(false));
            }
          }}
          onPointerCancel={() => {
            clearTimeout(askHold.current.timer);
            if (askHold.current.held) void endVoice();
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          ✦ Ask
        </button>
        <button className="btn btn-ghost" onClick={() => key('Home')}>⌂ Home</button>
        <button className="btn btn-ghost" onClick={() => (tick(), send({ type: 'player', action: 'toggle' }))}>
          {np?.playing ? '⏸' : '⏯'}
        </button>
      </div>
      <p className="muted small remote-tip">Hold ✦ Ask to talk to Claude · tap it for suggestions</p>

      <button className="more-toggle" onClick={() => setMore((m) => !m)}>
        {more ? '▴ Less' : '▾ More'}
      </button>
      {more && (
        <>
          <div className="remote-row">
            <button className="btn btn-ghost" onClick={() => (tick(), send({ type: 'player', action: 'back' }))}>⏪ 10s</button>
            <button className="btn btn-ghost" onClick={() => (tick(), send({ type: 'player', action: 'forward' }))}>10s ⏩</button>
            <button className="btn btn-ghost" onClick={() => (tick(), send({ type: 'newSet' }, '↻ New set on the TV.'))}>↻ New set</button>
          </div>
          <div className="remote-actions">
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
          {feed && (
            <main>
              <p className="planner-note">The TV’s set: tap a video to play it there.</p>
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
        </>
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
