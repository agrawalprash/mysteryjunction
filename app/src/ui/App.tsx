import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { claudeAuth, loadKeys, saveKeys, type ApiKeys } from '../lib/keys.ts';
import { diagSnapshot, sayDiag, startDiag, stopDiag } from '../lib/diagStore.ts';
import { startLinkServer, type LinkMessage } from '../lib/link.ts';
import { ask, getTold, mergeTold, newSet, onResume, search, setsLeftToday, startBackground, todaysFeed } from '../lib/wander.ts';
import { controlPlayer, nowPlaying } from '../lib/nowPlaying.ts';
import { checkForUpdate, installUpdate } from '../lib/updater.ts';
import type { Candidate, DailyFeed } from '../engine/types.ts';

declare const __APP_VERSION__: string;

/** The TV's current set, without the bulky bits, for showing on the phone. */
function compactFeed(feed: DailyFeed | null) {
  if (!feed) return null;
  const slim = (c: Candidate): Candidate => ({ ...c, description: undefined });
  return { ...feed, rows: feed.rows.map((r) => ({ ...r, items: r.items.map(slim) })), shorts: feed.shorts.map(slim) };
}
import { onToast, toast } from '../lib/toast.ts';
import { detectTv } from '../lib/device.ts';
import { getSettings } from '../lib/settings.ts';
import { enableSpatialNav, focusFirst } from '../lib/spatialNav.ts';
import { closeOverlay } from '../lib/overlay.ts';
import { Setup } from './Setup.tsx';
import { Home } from './Home.tsx';
import { Player } from './Player.tsx';
import { preloadSearch, Search } from './Search.tsx';
import { Settings } from './Settings.tsx';
import { UpdatePopup } from './UpdatePopup.tsx';
import { RemoteScreen } from './RemoteScreen.tsx';

export type Screen =
  | { kind: 'home' }
  | { kind: 'player'; video: Candidate }
  | { kind: 'search'; target?: 'here' | 'tv'; voice?: boolean }
  | { kind: 'remote' }
  | { kind: 'settings' }
  | { kind: 'setup' };

/** True when the TV (remote-control) layout is active. */
export const TvContext = createContext(false);
export const useTv = () => useContext(TvContext);

export function App() {
  const [keys, setKeys] = useState<ApiKeys | null>(null);
  const [deviceIsTv, setDeviceIsTv] = useState(false);
  const [tvPref, setTvPref] = useState(getSettings().tvMode);
  const [stack, setStack] = useState<Screen[]>([{ kind: 'home' }]);
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const tv = tvPref === 'on' || (tvPref === 'auto' && deviceIsTv);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const [notice, setNotice] = useState('');
  const [searchVersion, setSearchVersion] = useState(0);

  useEffect(() => {
    let timer: number | undefined;
    const off = onToast((m) => {
      setNotice(m);
      clearTimeout(timer);
      timer = window.setTimeout(() => setNotice(''), 9000);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);

  // Keep the video pool topped up in the background while the app is open.
  useEffect(() => {
    if (keys?.youtube) startBackground(keys);
  }, [keys]);
  useEffect(() => {
    const h = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) onResume();
    });
    return () => {
      h.then((x) => x.remove());
    };
  }, []);

  // On the TV, listen for requests from Wander on your phone (same Wi-Fi, pairing code).
  useEffect(() => {
    if (!tv) return;
    startLinkServer(async (msg: LinkMessage) => {
      const k = keysRef.current;
      switch (msg.type) {
        case 'hello':
          return { ok: true, name: 'Wander TV' };
        case 'keys': {
          const next = { youtube: msg.youtube, anthropic: msg.anthropic, anthropicWorkspace: msg.anthropicWorkspace, github: msg.github ?? keysRef.current?.github };
          await saveKeys(next);
          setKeys(next);
          toast('📱 Your phone sent the API keys.');
          return { ok: true };
        }
        case 'sync':
          return { told: mergeTold(msg.told as ReturnType<typeof getTold>) };
        case 'newSet':
          if (!k?.youtube) throw new Error('The TV has no YouTube key yet. Send your keys first.');
          toast('📱 Your phone asked for a new set…');
          await newSet(k, '', () => undefined);
          return { ok: true };
        case 'diag': {
          if (msg.action === 'start') {
            const auth = k ? claudeAuth(k) : null;
            if (!auth) throw new Error('The TV has no Anthropic key yet. Send your keys first.');
            startDiag(auth, msg.text ?? '');
            toast('📱 Diagnosis started from your phone (Settings → Diagnose to watch).');
          } else if (msg.action === 'say') sayDiag(msg.text ?? '');
          else if (msg.action === 'stop') stopDiag();
          return diagSnapshot(true);
        }
        case 'tvState': {
          const feed = todaysFeed();
          const feedVersion = feed?.generatedAt ?? 0;
          return {
            version: __APP_VERSION__,
            screen: stackRef.current[stackRef.current.length - 1].kind,
            nowPlaying: nowPlaying(),
            setsLeft: setsLeftToday(),
            feedVersion,
            feed: msg.feedVersion === feedVersion ? undefined : compactFeed(feed),
          };
        }
        case 'play':
          setStack((st) =>
            st[st.length - 1].kind === 'player' ? [...st.slice(0, -1), { kind: 'player', video: msg.video }] : [...st, { kind: 'player', video: msg.video }],
          );
          return { ok: true };
        case 'player':
          if (msg.action === 'close') {
            if (stackRef.current[stackRef.current.length - 1].kind === 'player') back();
            return { ok: true };
          }
          return { ok: controlPlayer(msg.action) };
        case 'home':
          setStack([{ kind: 'home' }]);
          return { ok: true };
        case 'update': {
          const info = await checkForUpdate(true);
          if (!info) return { upToDate: true, version: __APP_VERSION__ };
          toast(`📱 Updating to ${info.name}… confirm “Install” with the remote.`);
          const status = await installUpdate(info, () => undefined);
          return { status, version: info.name };
        }
        case 'search': {
          if (!k?.youtube) throw new Error('The TV has no keys yet. Send your keys first.');
          toast(`📱 Searching for “${msg.q}”…`);
          const results = await search(msg.q, k);
          preloadSearch(msg.q, results);
          setSearchVersion((n) => n + 1);
          setStack((st) => (st[st.length - 1].kind === 'search' ? st : [...st, { kind: 'search' }]));
          return { count: results.length };
        }
        case 'ask': {
          if (!k?.youtube) throw new Error('The TV has no keys yet. Send your keys first.');
          toast(`📱 “${msg.text}”`);
          const out = await ask(k, msg.text, () => undefined);
          toast(`✦ ${out.reply}`);
          return { reply: out.reply, changes: out.changes, newSet: !!out.feed, notice: out.notice };
        }
      }
    }).catch((e) => console.warn('Link server failed', e));
  }, [tv]);

  useEffect(() => {
    loadKeys().then(setKeys);
    detectTv().then(setDeviceIsTv);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('tv', tv);
    document.documentElement.classList.toggle('tv', tv);
    if (tv) enableSpatialNav();
  }, [tv]);

  // Remember where focus was on Home, so coming back on TV lands on the same card.
  const homeFocus = useRef<HTMLElement | null>(null);
  const push = useCallback((s: Screen) => {
    if (stackRef.current[stackRef.current.length - 1].kind === 'home') homeFocus.current = document.activeElement as HTMLElement;
    setStack((st) => [...st, s]);
  }, []);
  const back = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)), []);
  const replace = useCallback((s: Screen) => setStack((st) => [...st.slice(0, -1), s]), []);

  // Android back button (and the remote's Back) walks back through screens, then leaves the app.
  useEffect(() => {
    const handle = CapApp.addListener('backButton', () => {
      if (closeOverlay()) return;
      if (stackRef.current.length > 1) back();
      else CapApp.minimizeApp();
    });
    return () => {
      handle.then((h) => h.remove());
    };
  }, [back]);

  const current = stack[stack.length - 1];

  // On TV, put focus somewhere useful whenever the screen changes.
  useEffect(() => {
    if (!tv) return;
    const t = window.setTimeout(() => {
      const prev = homeFocus.current;
      if (current.kind === 'home' && prev?.isConnected) prev.focus({ preventScroll: true });
      else focusFirst();
    }, 60);
    return () => clearTimeout(t);
  }, [tv, current]);

  if (!keys) return <div className="splash">Wander</div>;

  const needsSetup = !keys.youtube;

  let content;
  if (needsSetup || current.kind === 'setup') {
    content = (
      <Setup
        initial={keys}
        canCancel={!needsSetup}
        onDone={(k) => {
          setKeys(k);
          setStack([{ kind: 'home' }]);
        }}
        onCancel={back}
      />
    );
  } else {
    content = (
      <>
        {/* Home stays mounted underneath so its scroll position survives. */}
        <div style={{ display: current.kind === 'home' ? 'block' : 'none' }}>
          <Home keys={keys} open={(v) => push({ kind: 'player', video: v })} go={push} visible={current.kind === 'home'} />
        </div>
        {current.kind === 'player' && (
          <Player key={current.video.id} video={current.video} onBack={back} open={(v) => replace({ kind: 'player', video: v })} />
        )}
        {current.kind === 'search' && (
          <Search
            key={searchVersion}
            keys={keys}
            onBack={back}
            open={(v) => push({ kind: 'player', video: v })}
            initialTarget={current.target}
            startWithVoice={current.voice}
          />
        )}
        {current.kind === 'remote' && (
          <RemoteScreen
            keys={keys}
            onBack={back}
            openSearch={() => push({ kind: 'search', target: 'tv', voice: true })}
            openDiagnose={() => push({ kind: 'settings' })}
          />
        )}
        {current.kind === 'settings' && (
          <Settings
            keys={keys}
            onBack={back}
            editKeys={() => push({ kind: 'setup' })}
            onTvModeChange={setTvPref}
            deviceIsTv={deviceIsTv}
            onKeys={setKeys}
          />
        )}
      </>
    );
  }
  return (
    <TvContext.Provider value={tv}>
      {content}
      {keys.youtube && <UpdatePopup tv={tv} />}
      {notice && <div className="toast">{notice}</div>}
    </TvContext.Provider>
  );
}
