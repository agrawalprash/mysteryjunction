// Checks GitHub for a newer release and installs it from inside the app.

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { load, save } from './store.ts';

declare const __APP_VERSION_CODE__: number;

const REPO = 'agrawalprash/mysteryjunction';
const CHECK_EVERY = 3 * 60 * 60 * 1000;

interface UpdaterPlugin {
  currentVersion(): Promise<{ versionName: string; versionCode: number }>;
  install(opts: { url: string }): Promise<{ status: 'installer-opened' | 'needs-permission' }>;
  addListener(event: 'progress', fn: (e: { percent: number }) => void): Promise<PluginListenerHandle>;
}
const Updater = registerPlugin<UpdaterPlugin>('WanderUpdater');

export interface UpdateInfo {
  versionCode: number;
  name: string;
  notes: string;
  apkUrl: string;
}

export async function currentVersionCode(): Promise<number> {
  if (Capacitor.isNativePlatform()) {
    try {
      return Number((await Updater.currentVersion()).versionCode);
    } catch {
      /* fall through */
    }
  }
  return __APP_VERSION_CODE__;
}

/** Version code from a tag like "v0.1.7" (the last number is the build number). */
export function codeFromTag(tag: string): number {
  const m = /(\d+)\s*$/.exec(tag);
  return m ? Number(m[1]) : 0;
}

/** Returns the newer release, or null if this is the latest. Cached for a few hours unless forced. */
export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  const cached = load<{ at: number; info: UpdateInfo | null } | null>('update-check', null);
  const current = await currentVersionCode();
  if (!force && cached && Date.now() - cached.at < CHECK_EVERY) {
    return cached.info && cached.info.versionCode > current ? cached.info : null;
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`Couldn’t check for updates (GitHub said ${res.status}).`);
  const rel = await res.json();
  const asset = (rel.assets ?? []).find((a: { name: string }) => a.name === 'Wander.apk') ?? (rel.assets ?? []).find((a: { name: string }) => a.name.endsWith('.apk'));
  const info: UpdateInfo | null = asset
    ? {
        versionCode: codeFromTag(rel.tag_name ?? ''),
        name: rel.name ?? rel.tag_name,
        notes: String(rel.body ?? '').split('\n').filter((l: string) => l.trim() && !/^(On your phone|Built from|Co-Authored-By|Claude-Session|Merge pull request)/.test(l.trim())).slice(0, 8).join('\n'),
        apkUrl: asset.browser_download_url,
      }
    : null;
  save('update-check', { at: Date.now(), info });
  return info && info.versionCode > current ? info : null;
}

/** Download the APK and open Android's installer. Reports download progress (0–100). */
export async function installUpdate(info: UpdateInfo, onProgress: (pct: number) => void): Promise<'installer-opened' | 'needs-permission'> {
  if (!Capacitor.isNativePlatform()) {
    window.open(info.apkUrl, '_blank');
    return 'installer-opened';
  }
  const handle = await Updater.addListener('progress', (e) => onProgress(e.percent));
  try {
    return (await Updater.install({ url: info.apkUrl })).status;
  } finally {
    handle.remove();
  }
}
