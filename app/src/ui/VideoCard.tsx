import type { Candidate } from '../engine/types.ts';
import { decodeEntities, formatAge, formatCount, formatDuration } from '../lib/format.ts';
import { readFocused } from '../lib/readAloud.ts';
import { useTv } from './App.tsx';

export function VideoCard({
  video,
  onOpen,
  variant = 'row',
  watched = false,
}: {
  video: Candidate;
  onOpen: (v: Candidate) => void;
  variant?: 'row' | 'list' | 'short';
  watched?: boolean;
}) {
  const tv = useTv();
  const why = video.why || video.because;
  const meta = [
    video.views ? `${formatCount(video.views)} views` : '',
    formatAge(video.publishedAt),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      className={`card card-${variant}${watched ? ' card-watched' : ''}`}
      onClick={() => onOpen(video)}
      onFocus={tv ? () => readFocused(video.why) : undefined}
    >
      <div className="thumb">
        <img src={video.thumb} alt="" loading="lazy" />
        {variant !== 'short' && video.durationSec > 0 && <span className="duration">{formatDuration(video.durationSec)}</span>}
        {watched && <span className="watched-badge">Watched</span>}
      </div>
      <div className="card-body">
        <div className="card-title">{decodeEntities(video.title)}</div>
        {variant !== 'short' && <div className="card-channel">{decodeEntities(video.channelTitle)}</div>}
        {variant !== 'short' && meta && <div className="card-meta">{meta}</div>}
        {variant !== 'short' && why && <div className={`card-because${video.why ? ' card-why' : ''}`}>{why}</div>}
      </div>
    </button>
  );
}
