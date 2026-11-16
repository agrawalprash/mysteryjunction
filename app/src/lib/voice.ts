// Voice input through the device's speech recogniser, plus the remote's mic button.

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

interface VoicePlugin {
  listen(opts: { language?: string; prompt?: string }): Promise<{ text: string }>;
  holdStart(opts: { language?: string }): Promise<void>;
  holdStop(): Promise<{ text: string; error?: string }>;
  holdCancel(): Promise<void>;
  say(opts: { text: string }): Promise<void>;
  addListener(event: 'holdPartial', fn: (e: { text: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'holdReady', fn: () => void): Promise<PluginListenerHandle>;
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

// ---------------------------------------------------------------- hold to talk

/**
 * Walkie-talkie style: start listening while a button is held, show words as they come,
 * and get the final text on release. (Web preview: falls back to a typed prompt on release.)
 */
export async function holdStart(onPartial: (text: string) => void, onReady: () => void): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) {
    onReady();
    return () => undefined;
  }
  const a = await Voice.addListener('holdPartial', (e) => onPartial(e.text));
  const b = await Voice.addListener('holdReady', () => onReady());
  await Voice.holdStart({ language: 'en-US' });
  return () => {
    a.remove();
    b.remove();
  };
}

export async function holdStop(): Promise<string> {
  if (!Capacitor.isNativePlatform()) return window.prompt('What did you say?') ?? '';
  const r = await Voice.holdStop();
  if (!r.text && r.error) throw new Error(r.error);
  return r.text;
}

export function holdCancel() {
  if (Capacitor.isNativePlatform()) void Voice.holdCancel();
}

// ---------------------------------------------------------------- read aloud

/** Say a short line aloud, replacing whatever is being said (empty text just stops). */
export function sayAloud(text: string) {
  if (Capacitor.isNativePlatform()) {
    void Voice.say({ text }).catch(() => undefined);
    return;
  }
  try {
    window.speechSynthesis?.cancel();
    if (text) window.speechSynthesis?.speak(new SpeechSynthesisUtterance(text));
  } catch {
    /* no speech here */
  }
}
