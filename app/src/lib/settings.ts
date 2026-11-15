// User preferences (not secrets).

import { load, save } from './store.ts';

export interface Settings {
  /** 'auto' follows the device: TV layout on Android TV, phone layout elsewhere. */
  tvMode: 'auto' | 'on' | 'off';
  /** Language for searches and Claude's topic picks. The app itself is always English. */
  language: string;
}

const DEFAULTS: Settings = { tvMode: 'auto', language: 'en' };

export function getSettings(): Settings {
  return { ...DEFAULTS, ...load<Partial<Settings>>('settings', {}) };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  save('settings', next);
  return next;
}

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'hi', label: 'Hindi' },
];
