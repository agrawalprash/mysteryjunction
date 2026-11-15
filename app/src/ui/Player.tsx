import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candidate } from '../engine/types.ts';
import { likeRatio, quality, isHiddenGem } from '../engine/feed.ts';
import { decodeEntities, formatAge, formatCount, formatDuration } from '../lib/format.ts';
import { loadYouTubeApi, type YTPlayer } from '../lib/ytPlayer.ts';
import { hideChannel, lessLikeThis, markOpened, recordWatch, related } from '../lib/wander.ts';
import { VideoCard } from './VideoCard.tsx';

const TIER_EXPLAIN: Record<Candidate['tier'], string> = {
  core: 'One of your interests, from an angle you haven’t seen yet.',
  adjacent: 'A step away from something you like. This is how new interests start.',
  wildcard: 'A deliberate wildcard, unrelated to your usual picks.',
  archive: 'An older video, picked because good things don’t expire.',
  shorts: 'A short, light pick.',
  search: 'From something you searched for.',
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
  const holder = useRef<HTMLDivElement>(null);
  const watchedSec = useRef(0);
  const duration = useRef(video.durationSec);
  const [error, setError] = useState('');
  const [showWhy, setShowWhy] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const isShort = video.tier === 'shorts' || (video.durationSec > 0 && video.durationSec <= 60);
  const rel = useMemo(() => related(video), [video]);

  useEffect(() => {
    markOpened(video);
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
          playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: window.location.origin },
          events: {
            onReady: (e) => {
              const d = e.target.getDuration();
              if (d) duration.current = d;
            },
            onError: (e) => setError(PLAYER_ERRORS[e.data] ?? `YouTube couldn’t play this (error ${e.data}).`),
          },
        });
        // Count seconds actually spent playing (not seeking or paused).
        timer = window.setInterval(() => {
          try {
            if (player?.getPlayerState() === YT.PlayerState.PLAYING) watchedSec.current += 1;
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
      recordWatch(video, watchedSec.current, Math.round(duration.current));
    };
  }, [video]);

  const lr = likeRatio(video);

  return (
    <div className="screen player-screen">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
      </header>
      <div className={`player-frame${isShort ? ' player-short' : ''}`} ref={holder}>
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
            <p>
              <strong>{video.because || 'Picked for variety'}</strong>
            </p>
            <p>{TIER_EXPLAIN[video.tier]}</p>
            <dl>
              <dt>Topic</dt>
              <dd>{video.topic}</dd>
              <dt>Distance</dt>
              <dd>{video.tier}</dd>
              {video.query && (
                <>
                  <dt>Search used</dt>
                  <dd>{video.query}</dd>
                </>
              )}
              {video.views > 0 && (
                <>
                  <dt>Like ratio</dt>
                  <dd>
                    {(lr * 100).toFixed(1)}% {isHiddenGem(video) ? '(hidden gem)' : ''}
                  </dd>
                  <dt>Quality score</dt>
                  <dd>{quality(video).toFixed(2)}</dd>
                </>
              )}
            </dl>
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
