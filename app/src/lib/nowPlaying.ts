// What the TV is playing right now, so the phone can show it and control it.

import type { Candidate } from '../engine/types.ts';
import type { YTPlayer } from './ytPlayer.ts';

let current: { video: Candidate; player: YTPlayer } | null = null;

export function setNowPlaying(video: Candidate, player: YTPlayer) {
  current = { video, player };
}

export function clearNowPlaying(videoId: string) {
  if (current?.video.id === videoId) current = null;
}

export interface NowPlaying {
  id: string;
  title: string;
  channelTitle: string;
  thumb: string;
  playing: boolean;
  time: number;
  duration: number;
}

export function nowPlaying(): NowPlaying | null {
  if (!current) return null;
  const { video, player } = current;
  let time = 0;
  let duration = video.durationSec;
  let playing = false;
  try {
    time = player.getCurrentTime();
    duration = player.getDuration() || duration;
    playing = player.getPlayerState() === 1;
  } catch {
    /* player not ready yet */
  }
  return { id: video.id, title: video.title, channelTitle: video.channelTitle, thumb: video.thumb, playing, time, duration };
}

export type PlayerAction = 'toggle' | 'back' | 'forward';

export function controlPlayer(action: PlayerAction): boolean {
  if (!current) return false;
  const p = current.player;
  try {
    if (action === 'toggle') {
      if (p.getPlayerState() === 1) p.pauseVideo();
      else p.playVideo();
    } else {
      const t = p.getCurrentTime() + (action === 'forward' ? 10 : -10);
      p.seekTo(Math.max(0, t), true);
    }
    return true;
  } catch {
    return false;
  }
}
