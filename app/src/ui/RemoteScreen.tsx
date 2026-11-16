import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candidate, DailyFeed } from '../engine/types.ts';
import { linkedTv, sendToTv, type LinkMessage } from '../lib/link.ts';
import type { NowPlaying } from '../lib/nowPlaying.ts';
import { formatDuration } from '../lib/format.ts';
import { holdCancel, holdStart, holdStop } from '../lib/voice.ts';
import { createGestures } from '../lib/gestures.ts';
import { VideoCard } from './VideoCard.tsx';
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
export function RemoteScreen({ onBack }: { onBack: () => void }) {
  const tv = linkedTv();
  const [state, setState] = useState<TvState | null>(null);
  const [feed, setFeed] = useState<DailyFeed | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [voice, setVoice] = useState<{ text: string; ready: boolean } | null>(null);
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

  const startVoice = () => {
    tick(25);
    setStatus('');
    setVoice({ text: '', ready: false });
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
    try {
      const said = (await holdStop()).trim();
      setVoice(null);
      if (!said) return;
      await deliver(said);
    } catch (e) {
      setVoice(null);
      setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      cleanup();
    }
  };

  /** Send what was said to the TV: Claude works out whether it's a place, a search or a change. */
  const deliver = async (said: string) => {
    try {
      setStatus(`✦ “${said}”…`);
      const r = (await sendToTv({ type: 'ask', text: said })) as { reply?: string; changes?: string[] };
      setStatus(`✦ ${r.reply ?? 'Done.'}${r.changes?.length ? ` (${r.changes.join(', ')})` : ''}`);
    } catch (e) {
      setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
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
        holdStart: () => startVoice(),
        holdEnd: () => void endVoice(),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );


  const np = state?.nowPlaying;

  // Status messages show briefly at the top of the pad, then fade.
  useEffect(() => {
    if (!status) return;
    const t = window.setTimeout(() => setStatus(''), 7000);
    return () => clearTimeout(t);
  }, [status]);

  // Corner and bar buttons must not start pad gestures.
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div className="screen remote remote-clean">
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
        <button className="pad-corner pad-exit" aria-label="Leave the remote" onPointerDown={stop} onClick={onBack}>
          ✕
        </button>
        <span
          className={`pad-corner pad-dot link-dot${error ? ' link-dot-bad' : state ? ' link-dot-ok' : ''}`}
          title={error || 'Connected'}
        />

        <div className="pad-status">
          {voice ? (
            <span className="voice-live">{voice.text || (voice.ready ? 'Listening… speak now' : 'Starting the mic…')}</span>
          ) : status ? (
            <span>{status}</span>
          ) : !tv ? (
            <span className="pad-error">No TV linked: Settings → Link to TV</span>
          ) : error ? (
            <span className="pad-error">Can’t reach the TV. Is Wander open on it?</span>
          ) : null}
        </div>

        {voice ? (
          <div className="touchpad-voice">
            <div className="touchpad-mic">🎤</div>
            <div>Release to send</div>
          </div>
        ) : (
          <div className="touchpad-hint">
            <div className="pad-hint-mic">🎤</div>
            <div>Hold to speak</div>
            <div className="muted small">Swipe to move · Tap for OK</div>
          </div>
        )}
      </div>

      <nav className="remote-bar">
        <button onClick={() => key('Back')}>← Back</button>
        <button
          onClick={() => {
            setMore(true);
            setOverlayCloser(() => setMore(false));
          }}
        >
          More
        </button>
      </nav>

      {more && (
        <div
          className="sheet-backdrop"
          onClick={() => {
            setMore(false);
            setOverlayCloser(null);
          }}
        >
          <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="More">
            <div className="remote-row">
              <button className="btn btn-ghost" onClick={() => (tick(), send({ type: 'player', action: 'back' }))}>⏪ 10s</button>
              <button className="btn" onClick={() => (tick(), send({ type: 'player', action: 'toggle' }))}>{np?.playing ? '⏸' : '⏯'}</button>
              <button className="btn btn-ghost" onClick={() => (tick(), send({ type: 'player', action: 'forward' }))}>10s ⏩</button>
            </div>
            {np && (
              <p className="muted small more-np">
                ▶ {np.title} · {formatDuration(Math.round(np.time))} / {formatDuration(Math.round(np.duration))}
              </p>
            )}
            <div className="remote-actions">
              <button className="btn btn-ghost" onClick={() => (tick(), send({ type: 'newSet' }, '↻ New set on the TV.'))}>
                ↻ New set
              </button>
            </div>
            {error && <p className="small error-text">{error}</p>}
            {feed && (
              <>
                <h3 className="list-title">The TV’s set: tap to play there</h3>
                {feed.rows.map((row) => (
                  <section key={row.id} className="row">
                    <h2>{row.title}</h2>
                    <div className="row-scroll">
                      {row.items.map((v: Candidate) => (
                        <VideoCard
                          key={v.id}
                          video={v}
                          onOpen={(c) => {
                            setMore(false);
                            setOverlayCloser(null);
                            void send({ type: 'play', video: c }, `▶ Playing on the TV: ${c.title}`);
                          }}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
