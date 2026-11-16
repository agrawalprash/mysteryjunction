// Profiles: everyone uses the same Wander. A profile is a name, its own taste/pool/history
// (stored separately by wander.ts), and a few options. Presets only set the starting options.

import { load, remove, save } from './store.ts';

export type Preset = 'adult' | 'kid';

export interface ProfileOptions {
  /** Claude plans, explains and talks in a playful, curious way suited to a young child. */
  playful: boolean;
  /** YouTube's strict SafeSearch for everything this profile searches. */
  strictSafeSearch: boolean;
  /** Read the focused card's "why this" line aloud on the TV. */
  readAloud: boolean;
  /** Daily time budget with a visible timer, last-video warning and goodbye. */
  timer: boolean;
  dailyMinutes: number;
  /** Only show videos Claude judged suitable for young children. */
  contentCheck: boolean;
  /** A simple home: six big picks instead of rows. */
  simpleHome: boolean;
  /** Share of each set from what this profile already loves (0.2 mostly new, 0.4 balanced, 0.6 mostly familiar). */
  familiar: number;
}

export interface WanderProfile {
  id: string;
  name: string;
  preset: Preset;
  options: ProfileOptions;
}

export const PRESETS: Record<Preset, ProfileOptions> = {
  adult: { playful: false, strictSafeSearch: false, readAloud: false, timer: false, dailyMinutes: 90, contentCheck: false, simpleHome: false, familiar: 0.4 },
  kid: { playful: true, strictSafeSearch: true, readAloud: true, timer: true, dailyMinutes: 45, contentCheck: true, simpleHome: true, familiar: 0.5 },
};

export const PRESET_LABELS: Record<Preset, string> = { adult: 'Grown-up', kid: 'Kid' };

/** The first profile keeps the storage Wander used before profiles existed. */
export const MAIN_ID = 'main';

function defaults(): WanderProfile[] {
  return [{ id: MAIN_ID, name: 'Me', preset: 'adult', options: { ...PRESETS.adult } }];
}

export function listProfiles(): WanderProfile[] {
  const list = load<WanderProfile[]>('profiles', []);
  if (!Array.isArray(list) || list.length === 0) return defaults();
  // Older saves may lack newer options.
  return list.map((p) => ({ ...p, options: { ...PRESETS[p.preset] ?? PRESETS.adult, ...p.options } }));
}

function saveProfiles(list: WanderProfile[]) {
  save('profiles', list);
}

export function activeProfile(): WanderProfile {
  const list = listProfiles();
  const id = load<string>('active-profile', MAIN_ID);
  return list.find((p) => p.id === id) ?? list[0];
}

/** Only wander.ts should call this (it also swaps the profile's data). */
export function setActiveProfileId(id: string) {
  save('active-profile', id);
}

/** Where a profile's taste, pool and history are stored. */
export function stateKey(id = activeProfile().id): string {
  return id === MAIN_ID ? 'state' : `state:${id}`;
}

export function addProfile(name: string, preset: Preset): WanderProfile {
  const p: WanderProfile = {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: name.trim() || (preset === 'kid' ? 'Kid' : 'Guest'),
    preset,
    options: { ...PRESETS[preset] },
  };
  saveProfiles([...listProfiles(), p]);
  return p;
}

export function updateProfile(id: string, patch: Partial<Omit<WanderProfile, 'id' | 'options'>> & { options?: Partial<ProfileOptions> }) {
  saveProfiles(
    listProfiles().map((p) => {
      if (p.id !== id) return p;
      // Changing the preset resets the options to that preset's.
      const base = patch.preset && patch.preset !== p.preset ? PRESETS[patch.preset] : p.options;
      return { ...p, ...patch, options: { ...base, ...patch.options } };
    }),
  );
}

/** Delete a profile and everything it learned. The main profile can't be deleted. */
export function deleteProfile(id: string) {
  if (id === MAIN_ID) return;
  saveProfiles(listProfiles().filter((p) => p.id !== id));
  remove(stateKey(id));
  if (load<string>('active-profile', MAIN_ID) === id) save('active-profile', MAIN_ID);
}

// ---------------------------------------------------------------- parent PIN
// Kept on the device. It keeps a child from leaving their profile or changing settings,
// not a determined adult: it isn't a security boundary.

export function parentPin(): string {
  return load<string>('parent-pin', '');
}

export function setParentPin(pin: string) {
  if (pin) save('parent-pin', pin);
  else remove('parent-pin');
}

/** Whether moving from the active profile to `to` (or into Settings, when `to` is omitted) needs the PIN. */
export function needsPin(to?: WanderProfile): boolean {
  if (!parentPin()) return false;
  const from = activeProfile();
  if (to) return to.preset !== 'kid' && to.id !== from.id;
  return from.preset === 'kid';
}
