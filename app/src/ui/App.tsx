import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { claudeAuth, loadKeys, saveKeys, type ApiKeys } from '../lib/keys.ts';
import { diagSnapshot, sayDiag, startDiag, stopDiag } from '../lib/diagStore.ts';
import { linkedTv, startLinkServer, type LinkMessage } from '../lib/link.ts';
import { currentProfile, exploreAsk, exploreSearch, getTold, guideProfile, profileReport, mergeTold, newSet, onResume, setsLeftToday, startBackground, todaysFeed } from '../lib/wander.ts';
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
import { enableSpatialNav, focusFirst, remoteKey } from '../lib/spatialNav.ts';
import { closeOverlay } from '../lib/overlay.ts';
import { Setup } from './Setup.tsx';
import { Home } from './Home.tsx';
import { Player } from './Player.tsx';
import { ExploreHub, MapPage, ResultsPage, runExplore } from './Explore.tsx';
import { Settings } from './Settings.tsx';
import { UpdatePopup } from './UpdatePopup.tsx';
import { RemoteScreen } from './RemoteScreen.tsx';
import { ProfilePicker } from './Profiles.tsx';
import { Report } from './Report.tsx';
import { Goodbye } from './Goodbye.tsx';
import { PinPad } from './PinPad.tsx';
import { addMinutes, onTimeChanged, timeUp } from '../lib/screenTime.ts';
import { listProfiles } from '../lib/profiles.ts';

export type Screen =
  | { kind: 'home' }
  | { kind: 'player'; video: Candidate }
  | { kind: 'explore' }
  | { kind: 'place'; path: string[] }
  | { kind: 'results' }
  | { kind: 'remote' }
  | { kind: 'profiles' }
  | { kind: 'report' }
  | { kind: 'settings' }
  | { kind: 'setup' };

/** True when the TV (remote-control) layout is active. */
export const TvContext = createContext(false);
export const useTv = () => useContext(TvContext);

export function App() {
  const [keys, setKeys] = useState<ApiKeys | null>(null);
  const [deviceIsTv, setDeviceIsTv] = useState(false);
  const [detected, setDetected] = useState(false);
  const [tvPref, setTvPref] = useState(getSettings().tvMode);
  const [stack, setStack] = useState<Screen[]>([{ kind: 'home' }]);
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const tv = tvPref === 'on' || (tvPref === 'auto' && deviceIsTv);
  // Re-check the daily timer when time is added or used up.
  const [, setTimeTick] = useState(0);
  useEffect(() => onTimeChanged(() => setTimeTick((n) => n + 1)), []);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const [notice, setNotice] = useState('');
  // Phone requests (search, ask) show their results in Explore on the TV.
  const showExplore = () =>
    setStack((st) => (st[st.length - 1].kind === 'results' ? st : [{ kind: 'home' }, { kind: 'explore' }, { kind: 'results' }]));

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

  // A linked phone opens straight into remote mode (unless turned off in Settings).
  const autoRemote = useRef(false);
  useEffect(() => {
    if (!detected || autoRemote.current || !keys?.youtube) return;
    autoRemote.current = true;
    if (!tv && linkedTv() && getSettings().remoteOnStart) setStack([{ kind: 'home' }, { kind: 'remote' }]);
    // On the TV, with more than one profile, start with "Who's watching?".
    else if (tv && listProfiles().length > 1) setStack([{ kind: 'home' }, { kind: 'profiles' }]);
  }, [detected, keys, tv]);

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
            profile: currentProfile().name,
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
        case 'key':
          // The phone's D-pad: the same as pressing keys on the TV remote.
          if (msg.key === 'Back') {
            if (!closeOverlay() && stackRef.current.length > 1) back();
          } else if (msg.key === 'Home') setStack([{ kind: 'home' }]);
          else remoteKey(msg.key);
          return { ok: true };
        case 'update': {
          const info = await checkForUpdate(true);
          if (!info) return { upToDate: true, version: __APP_VERSION__ };
          toast(`📱 Updating to ${info.name}… confirm “Install” with the remote.`);
          const status = await installUpdate(info, () => undefined);
          return { status, version: info.name };
        }
        case 'report':
          return { profiles: listProfiles(), active: currentProfile().id, report: profileReport(msg.profileId ?? currentProfile().id) };
        case 'extend':
          addMinutes(msg.profileId, msg.minutes);
          toast(`📱 ${msg.minutes} more minutes added from the phone.`);
          return { profiles: listProfiles(), active: currentProfile().id, report: profileReport(msg.profileId) };
        case 'guide':
          guideProfile(msg.profileId, { addRule: msg.addRule, forget: msg.forget });
          return { profiles: listProfiles(), active: currentProfile().id, report: profileReport(msg.profileId) };
        case 'search': {
          if (!k?.youtube) throw new Error('The TV has no keys yet. Send your keys first.');
          showExplore();
          const r = await runExplore(() => exploreSearch(k, msg.q), msg.q);
          return { count: r.results.length + r.poolHits.length };
        }
        case 'ask': {
          if (!k?.youtube) throw new Error('The TV has no keys yet. Send your keys first.');
          showExplore();
          const r = await runExplore((p) => exploreAsk(k, msg.text, p), msg.text);
          return { reply: r.reply, changes: r.changes ?? [], newSet: r.newSet, notice: r.notice, count: r.results.length + r.poolHits.length };
        }
      }
    }).catch((e) => console.warn('Link server failed', e));
  }, [tv]);

  useEffect(() => {
    loadKeys().then(setKeys);
    detectTv().then((v) => {
      setDeviceIsTv(v);
      setDetected(true);
    });
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
  // Jump around the map: back up to a place already in the stack (a breadcrumb), or go to a new one.
  const goToPlace = useCallback((path: string[]) => {
    const id = path.join('›').toLowerCase();
    setStack((st) => {
      const i = st.findIndex((s) => (path.length === 0 ? s.kind === 'explore' : s.kind === 'place' && s.path.join('›').toLowerCase() === id));
      if (i >= 0) return st.slice(0, i + 1);
      return path.length === 0 ? [...st, { kind: 'explore' }] : [...st, { kind: 'place', path }];
    });
  }, []);
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
  document.body.classList.toggle('kid', currentProfile().options.simpleHome);
  // Kid profiles with the timer on: when today's time is used up, every screen but the
  // player (finishing the last video), the profile picker and settings becomes the goodbye.
  const showGoodbye = !needsSetup && timeUp() && !['player', 'profiles', 'settings', 'setup'].includes(current.kind);

  let content;
  if (showGoodbye) {
    content = <Goodbye keys={keys} onSwitchProfile={() => push({ kind: 'profiles' })} />;
  } else if (needsSetup || current.kind === 'setup') {
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
        {current.kind === 'explore' && (
          <ExploreHub keys={keys} onBack={back} openPlace={(path) => push({ kind: 'place', path })} openResults={() => push({ kind: 'results' })} />
        )}
        {current.kind === 'place' && (
          <MapPage
            key={current.path.join('›')}
            keys={keys}
            path={current.path}
            onBack={back}
            goTo={goToPlace}
            open={(v) => push({ kind: 'player', video: v })}
            openResults={() => push({ kind: 'results' })}
          />
        )}
        {current.kind === 'results' && (
          <ResultsPage onBack={back} goHome={() => setStack([{ kind: 'home' }])} open={(v) => push({ kind: 'player', video: v })} />
        )}
        {current.kind === 'report' && <Report keys={keys} onBack={back} />}
        {current.kind === 'profiles' && <ProfilePicker onDone={back} onManage={() => replace({ kind: 'settings' })} />}
        {current.kind === 'remote' && (
          <RemoteScreen
            onBack={back}
            openDiagnose={() => push({ kind: 'settings' })}
            openReport={() => push({ kind: 'report' })}
          />
        )}
        {current.kind === 'settings' && (
          <Settings
            keys={keys}
            onBack={back}
            editKeys={() => push({ kind: 'setup' })}
            onTvModeChange={setTvPref}
            deviceIsTv={deviceIsTv}
            openReport={() => push({ kind: 'report' })}
          />
        )}
      </>
    );
  }
  return (
    <TvContext.Provider value={tv}>
      {content}
      {keys.youtube && <UpdatePopup tv={tv} />}
      {!tv && keys.youtube && linkedTv() && ['home', 'explore', 'place', 'results', 'settings', 'report'].includes(current.kind) && (
        <button className="remote-fab" onClick={() => push({ kind: 'remote' })}>
          📺 Remote
        </button>
      )}
      <PinPad tv={tv} />
      {notice && <div className="toast">{notice}</div>}
    </TvContext.Provider>
  );
}
