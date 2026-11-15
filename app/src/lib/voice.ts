// Voice input through the device's speech recogniser, plus the remote's mic button.

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

interface VoicePlugin {
  listen(opts: { language?: string; prompt?: string }): Promise<{ text: string }>;
  addListener(event: 'voiceKey', fn: (e: { keyCode: number }) => void): Promise<PluginListenerHandle>;
}
const Voice = registerPlugin<VoicePlugin>('WanderVoice');

export const voiceAvailable = () => Capacitor.isNativePlatform();

/** Opens the speech recogniser and returns what was said (English). */
export async function listen(prompt = 'What are you in the mood for?'): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    // Web preview: no recogniser, so fall back to typing.
    return window.prompt(prompt) ?? '';
  }
  // Some TVs' voice screens never report back; don't wait forever.
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('The voice screen didn’t answer. Voice input may not work on this device.')), 40_000),
  );
  return (await Promise.race([Voice.listen({ language: 'en-US', prompt }), timeout])).text;
}

/** Called whenever the remote's mic/search button reaches the app. */
export function onVoiceKey(fn: (keyCode: number) => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => undefined;
  const h = Voice.addListener('voiceKey', (e) => fn(e.keyCode));
  return () => {
    h.then((x) => x.remove());
  };
}
