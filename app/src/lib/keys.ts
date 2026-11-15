// API keys live in Android's encrypted storage (Android Keystore), not in the
// code, the repo, or plain app storage. On the web preview it falls back to
// the plugin's browser implementation.

import { SecureStorage } from '@aparajita/capacitor-secure-storage';

export interface ApiKeys {
  youtube: string;
  anthropic: string;
  /** Only for Anthropic keys that aren't tied to one workspace (starts with "wrkspc_"). */
  anthropicWorkspace: string;
}

const YT = 'youtube_api_key';
const AN = 'anthropic_api_key';
const WS = 'anthropic_workspace_id';

export async function loadKeys(): Promise<ApiKeys> {
  try {
    const [youtube, anthropic, ws] = await Promise.all([SecureStorage.getItem(YT), SecureStorage.getItem(AN), SecureStorage.getItem(WS)]);
    return { youtube: youtube ?? '', anthropic: anthropic ?? '', anthropicWorkspace: ws ?? '' };
  } catch (e) {
    console.warn('Could not read keys', e);
    return { youtube: '', anthropic: '', anthropicWorkspace: '' };
  }
}

export async function saveKeys(keys: ApiKeys): Promise<void> {
  if (keys.youtube) await SecureStorage.setItem(YT, keys.youtube.trim());
  else await SecureStorage.removeItem(YT);
  if (keys.anthropic) await SecureStorage.setItem(AN, keys.anthropic.trim());
  else await SecureStorage.removeItem(AN);
  if (keys.anthropicWorkspace) await SecureStorage.setItem(WS, keys.anthropicWorkspace.trim());
  else await SecureStorage.removeItem(WS);
}

export function claudeAuth(keys: ApiKeys) {
  return keys.anthropic ? { apiKey: keys.anthropic, workspaceId: keys.anthropicWorkspace || undefined } : null;
}
