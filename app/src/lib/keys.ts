// API keys live in Android's encrypted storage (Android Keystore), not in the
// code, the repo, or plain app storage. On the web preview it falls back to
// the plugin's browser implementation.

import { SecureStorage } from '@aparajita/capacitor-secure-storage';

export interface ApiKeys {
  youtube: string;
  anthropic: string;
}

const YT = 'youtube_api_key';
const AN = 'anthropic_api_key';

export async function loadKeys(): Promise<ApiKeys> {
  try {
    const [youtube, anthropic] = await Promise.all([SecureStorage.getItem(YT), SecureStorage.getItem(AN)]);
    return { youtube: youtube ?? '', anthropic: anthropic ?? '' };
  } catch (e) {
    console.warn('Could not read keys', e);
    return { youtube: '', anthropic: '' };
  }
}

export async function saveKeys(keys: ApiKeys): Promise<void> {
  if (keys.youtube) await SecureStorage.setItem(YT, keys.youtube.trim());
  else await SecureStorage.removeItem(YT);
  if (keys.anthropic) await SecureStorage.setItem(AN, keys.anthropic.trim());
  else await SecureStorage.removeItem(AN);
}
