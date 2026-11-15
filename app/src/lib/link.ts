// Phone <-> TV link over the home Wi-Fi (see LinkPlugin.java).
// The TV shows a pairing code; the phone finds the TV on the network and sends
// requests that carry the code: "ask" (what you said), "keys", "sync", "newSet".

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { load, save, remove } from './store.ts';

interface LinkPlugin {
  startServer(): Promise<{ port: number; addresses: string[] }>;
  respond(opts: { id: string; status?: number; body: string }): Promise<void>;
  send(opts: { host: string; port: number; body: string; timeoutMs?: number }): Promise<{ status: number; body: string }>;
  discover(): Promise<{ found: { host: string; port: number; hello: string }[]; searched: string[] }>;
  addListener(event: 'message', fn: (e: { id: string; body: string }) => void): Promise<PluginListenerHandle>;
}
const Link = registerPlugin<LinkPlugin>('WanderLink');

export type LinkMessage =
  | { type: 'hello' }
  | { type: 'ask'; text: string }
  | { type: 'keys'; youtube: string; anthropic: string; anthropicWorkspace: string; github?: string }
  | { type: 'sync'; told: unknown }
  | { type: 'newSet' }
  | { type: 'search'; q: string }
  | { type: 'diag'; action: 'state' | 'start' | 'say' | 'stop'; text?: string };

// ---------------------------------------------------------------- TV side

export function pairingCode(): string {
  let code = load<string>('link-code', '');
  if (!code) {
    code = String(Math.floor(100000 + Math.random() * 900000));
    save('link-code', code);
  }
  return code;
}

export function newPairingCode(): string {
  remove('link-code');
  return pairingCode();
}

let serverInfo: { port: number; addresses: string[] } | null = null;
export const linkServerInfo = () => serverInfo;

/** Start listening for the phone. `handle` returns the JSON reply for each request. */
export async function startLinkServer(handle: (msg: LinkMessage) => Promise<unknown>): Promise<void> {
  if (!Capacitor.isNativePlatform() || serverInfo) return;
  serverInfo = await Link.startServer();
  await Link.addListener('message', async ({ id, body }) => {
    let status = 200;
    let reply: unknown;
    try {
      const parsed = JSON.parse(body) as { code?: string; message?: LinkMessage };
      if (parsed.code !== pairingCode()) {
        status = 403;
        reply = { error: 'Wrong pairing code. Check the code under Settings → Link a phone on the TV.' };
      } else {
        reply = await handle(parsed.message ?? { type: 'hello' });
      }
    } catch (e) {
      status = 500;
      reply = { error: e instanceof Error ? e.message : String(e) };
    }
    await Link.respond({ id, status, body: JSON.stringify(reply ?? {}) });
  });
}

// ---------------------------------------------------------------- phone side

export interface LinkedTv {
  host: string;
  port: number;
  code: string;
  name: string;
}

export const linkedTv = () => load<LinkedTv | null>('linked-tv', null);
export const unlinkTv = () => remove('linked-tv');

async function post(tv: Pick<LinkedTv, 'host' | 'port' | 'code'>, message: LinkMessage, timeoutMs = 120000) {
  const res = await Link.send({ host: tv.host, port: tv.port, body: JSON.stringify({ code: tv.code, message }), timeoutMs });
  const data = res.body ? JSON.parse(res.body) : {};
  if (res.status >= 400) throw new Error(data.error ?? `The TV answered with an error (${res.status}).`);
  return data;
}

/** Find a Wander TV on the network that accepts this code, and remember it. */
export async function linkWithCode(code: string, onProgress: (msg: string) => void): Promise<LinkedTv> {
  if (!Capacitor.isNativePlatform()) throw new Error('Linking only works in the installed app.');
  onProgress('Looking for Wander on your Wi-Fi…');
  const { found } = await Link.discover();
  if (found.length === 0) throw new Error('No TV with Wander open was found. Make sure Wander is open on the TV and both are on the same Wi-Fi.');
  for (const f of found) {
    try {
      onProgress(`Trying ${f.host}…`);
      const hello = await post({ host: f.host, port: f.port, code: code.trim() }, { type: 'hello' }, 8000);
      const tv: LinkedTv = { host: f.host, port: f.port, code: code.trim(), name: hello.name ?? 'TV' };
      save('linked-tv', tv);
      return tv;
    } catch {
      /* wrong code or not answering; try the next one */
    }
  }
  throw new Error('Found Wander on the network, but the code didn’t match. Check the code on the TV.');
}

/** Send to the linked TV; if its address changed, find it again once. */
export async function sendToTv(message: LinkMessage) {
  const tv = linkedTv();
  if (!tv) throw new Error('No TV linked yet (Settings → Link to TV).');
  try {
    return await post(tv, message);
  } catch (e) {
    if (!(e instanceof Error) || !/reach/i.test(e.message)) throw e;
    const { found } = await Link.discover();
    for (const f of found) {
      try {
        await post({ ...tv, host: f.host, port: f.port }, { type: 'hello' }, 8000);
        save('linked-tv', { ...tv, host: f.host, port: f.port });
        return await post({ ...tv, host: f.host, port: f.port }, message);
      } catch {
        /* keep looking */
      }
    }
    throw new Error('Couldn’t reach the TV. Is Wander open on it, and are both on the same Wi-Fi?');
  }
}
