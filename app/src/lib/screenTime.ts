// Daily TV time per profile: counted only while a video is actually playing.

import { activeProfile, listProfiles } from './profiles.ts';
import { load, localDate, save } from './store.ts';

interface Day {
  date: string;
  sec: number;
  /** Minutes a grown-up added today. */
  extra: number;
}

const key = (id: string) => `time:${id}`;

function today(id: string): Day {
  const d = load<Day>(key(id), { date: '', sec: 0, extra: 0 });
  return d.date === localDate() ? d : { date: localDate(), sec: 0, extra: 0 };
}

const listeners = new Set<() => void>();
export function onTimeChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called once a second while a video plays. */
export function tickWatching() {
  const p = activeProfile();
  if (!p.options.timer) return;
  const d = today(p.id);
  d.sec += 1;
  save(key(p.id), d);
  if (d.sec % 30 === 0) listeners.forEach((fn) => fn());
}

export interface TimeStatus {
  on: boolean;
  usedMin: number;
  budgetMin: number;
  /** Seconds left today (can go below zero while the last video finishes). */
  leftSec: number;
}

export function timeStatus(id = activeProfile().id): TimeStatus {
  const opts = listProfiles().find((x) => x.id === id)?.options;
  const d = today(id);
  const budget = (opts?.dailyMinutes ?? 45) + d.extra;
  return { on: !!opts?.timer, usedMin: Math.round(d.sec / 60), budgetMin: budget, leftSec: budget * 60 - d.sec };
}

export function timeUp(): boolean {
  const t = timeStatus();
  return t.on && t.leftSec <= 0;
}

/** A grown-up adds time for today. */
export function addMinutes(id: string, minutes: number) {
  const d = today(id);
  d.extra += minutes;
  save(key(id), d);
  listeners.forEach((fn) => fn());
}
