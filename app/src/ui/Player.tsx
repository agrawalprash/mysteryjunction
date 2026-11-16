import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candidate } from '../engine/types.ts';
import { decodeEntities, formatAge, formatCount, formatDuration } from '../lib/format.ts';
import { loadYouTubeApi, type YTPlayer } from '../lib/ytPlayer.ts';
import { clearNowPlaying, setNowPlaying } from '../lib/nowPlaying.ts';
import { hideChannel, lessLikeThis, markOpened, recordWatch, related } from '../lib/wander.ts';
import { VideoCard } from './VideoCard.tsx';
import { useTv } from './App.tsx';
import { stopReading } from '../lib/readAloud.ts';
import { tickWatching, timeStatus, timeUp } from '../lib/screenTime.ts';

const TIER_EXPLAIN: Record<Candidate['tier'], string> = {
  core: 'One of your interests, from an angle you haven’t seen yet.',
  adjacent: 'A step away from something you like. This is how new interests start.',
  wildcard: 'A deliberate wildcard, unrelated to your usual picks.',
  archive: 'An older video, picked because good things don’t expire.',
  shorts: 'A short, light pick.',
  search: 'From something you searched for.',
  focus: 'Part of what you asked Wander for.',
  custom: 'From one of the rows you asked Wander to add.',
};

const PLAYER_ERRORS: Record<number, string> = {
  2: 'This video link looks broken.',
  5: 'This video can’t play in the app.',
  100: 'This video was removed or made private.',
  101: 'The creator doesn’t allow this video to play outside YouTube.',
  150: 'The creator doesn’t allow this video to play outside YouTube.',
  152: 'YouTube refused to play this video here.',
  153: 'YouTube refused to play this video here.',
};

export function Player({ video, onBack, open }: { video: Candidate; onBack: () => void; open: (v: Candidate) => void }) {
  const tv = useTv();
  const holder = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [hint, setHint] = useState(tv);
  const watchedSec = useRef(0);
  const duration = useRef(video.durationSec);
  const [error, setError] = useState('');
  const [showWhy, setShowWhy] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const isShort = video.tier === 'shorts' || (video.durationSec > 0 && video.durationSec <= 60);
  const rel = useMemo(() => related(video), [video]);
  // Daily TV time (profiles with the timer on): a gentle notice, and the goodbye after the last video.
  const [timeNote, setTimeNote] = useState('');
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    markOpened(video);
    stopReading();
    let player: YTPlayer | null = null;
    let timer: number | undefined;
    let cancelled = false;
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !holder.current) return;
        const el = document.createElement('div');
        holder.current.appendChild(el);
        player = new YT.Player(el, {
          videoId: video.id,
          width: '100%',
          height: '100%',
          playerVars: { autoplay: 1, playsinline: 1, rel: 0, hl: 'en', origin: window.location.origin },
          events: {
            onReady: (e) => {
              playerRef.current = e.target;
              setNowPlaying(video, e.target);
              const d = e.target.getDuration();
              if (d) duration.current = d;
              // On TV the remote talks to our wrapper, never to the iframe directly.
              if (tv) e.target.getIframe().setAttribute('tabindex', '-1');
            },
            onError: (e) => setError(PLAYER_ERRORS[e.data] ?? `YouTube couldn’t play this (error ${e.data}).`),
            onStateChange: (e) => {
              // The video finished and today's time is used up: time for the goodbye.
              if (e.data === YT.PlayerState.ENDED && timeUp()) onBackRef.current();
            },
          },
        });
        // Count seconds actually spent playing (not seeking or paused).
        timer = window.setInterval(() => {
          try {
            if (player?.getPlayerState() === YT.PlayerState.PLAYING) {
              watchedSec.current += 1;
              tickWatching();
              const t = timeStatus();
              if (t.on && watchedSec.current % 5 === 0) {
                const videoLeft = Math.max(0, (player.getDuration() || duration.current) - player.getCurrentTime());
                if (t.leftSec < -20 * 60) {
                  // Never cut a video off, unless it runs far past the day's time.
                  player.pauseVideo();
                  onBackRef.current();
                } else if (t.leftSec <= videoLeft + 30) setTimeNote('This is the last one for today.');
                else if (t.leftSec <= 10 * 60) setTimeNote(`${Math.ceil(t.leftSec / 60)} minutes of TV left today.`);
                else setTimeNote('');
              }
            }
          } catch {
            /* player not ready yet */
          }
        }, 1000);
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      try {
        player?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      clearNowPlaying(video.id);
      recordWatch(video, watchedSec.current, Math.round(duration.current));
    };
  }, [video, tv]);

  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(false), 6000);
    return () => clearTimeout(t);
  }, [hint]);

  // TV remote: OK toggles play/pause, left/right seek, down moves on to the info below.
  const onRemoteKey = (e: React.KeyboardEvent) => {
    const p = playerRef.current;
    if (!tv || !p) return;
    const playing = p.getPlayerState() === 1;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'MediaPlayPause') {
      if (playing) p.pauseVideo();
      else p.playVideo();
    } else if (e.key === 'MediaPlay') p.playVideo();
    else if (e.key === 'MediaPause') p.pauseVideo();
    else if (e.key === 'ArrowLeft' || e.key === 'MediaRewind') p.seekTo(Math.max(0, p.getCurrentTime() - 10), true);
    else if (e.key === 'ArrowRight' || e.key === 'MediaFastForward') p.seekTo(p.getCurrentTime() + 10, true);
    else return;
    e.preventDefault();
    setHint(false);
  };


  return (
    <div className="screen player-screen">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
      </header>
      <div
        className={`player-frame${isShort ? ' player-short' : ''}`}
        ref={holder}
        {...(tv ? { tabIndex: 0, 'data-own-keys': true, 'data-autofocus': true, onKeyDown: onRemoteKey } : {})}
      >
        {timeNote && !error && <div className="time-note">{timeNote}</div>}
        {tv && hint && !error && <div className="tv-hint">OK play / pause · ◀ ▶ skip 10s · ▼ details and more</div>}
        {error && (
          <div className="player-error">
            <p>{error}</p>
            <a className="btn" href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noopener">
              Open in YouTube
            </a>
          </div>
        )}
      </div>

      <div className="player-info">
        <h1>{decodeEntities(video.title)}</h1>
        <div className="muted">
          {decodeEntities(video.channelTitle)}
          {video.views > 0 && ` · ${formatCount(video.views)} views`}
          {video.publishedAt && ` · ${formatAge(video.publishedAt)}`}
          {video.durationSec > 0 && ` · ${formatDuration(video.durationSec)}`}
        </div>

        <div className="chip-row">
          <button className="chip" onClick={() => setShowWhy((s) => !s)}>
            {showWhy ? 'Hide why' : 'Why this?'}
          </button>
          <button
            className="chip"
            disabled={!!dismissed}
            onClick={() => {
              lessLikeThis(video);
              setDismissed('Got it: less of this topic.');
            }}
          >
            Less like this
          </button>
          <button
            className="chip"
            disabled={!!dismissed}
            onClick={() => {
              hideChannel(video);
              setDismissed('Channel hidden.');
            }}
          >
            Hide channel
          </button>
          <a className="chip" href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noopener">
            Open in YouTube
          </a>
        </div>
        {dismissed && <p className="muted small">{dismissed}</p>}

        {showWhy && (
          <div className="why">
            {video.why && <p>{video.why}</p>}
            <p className="muted small">
              {video.because || 'Picked for variety'}. {TIER_EXPLAIN[video.tier]}
            </p>
          </div>
        )}
      </div>

      {(rel.sameTopic.length > 0 || rel.elsewhere.length > 0) && (
        <div className="related">
          {rel.sameTopic.length > 0 && (
            <>
              <h3>More on {video.topic}</h3>
              {rel.sameTopic.map((v) => (
                <VideoCard key={v.id} video={v} onOpen={open} variant="list" />
              ))}
            </>
          )}
          {rel.elsewhere.length > 0 && (
            <>
              <h3>Somewhere else entirely</h3>
              {rel.elsewhere.map((v) => (
                <VideoCard key={v.id} video={v} onOpen={open} variant="list" />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
