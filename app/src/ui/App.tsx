import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import type { Candidate } from '../engine/types.ts';
import { loadKeys, type ApiKeys } from '../lib/keys.ts';
import { detectTv } from '../lib/device.ts';
import { getSettings } from '../lib/settings.ts';
import { enableSpatialNav, focusFirst } from '../lib/spatialNav.ts';
import { Setup } from './Setup.tsx';
import { Home } from './Home.tsx';
import { Player } from './Player.tsx';
import { Search } from './Search.tsx';
import { Settings } from './Settings.tsx';

export type Screen =
  | { kind: 'home' }
  | { kind: 'player'; video: Candidate }
  | { kind: 'search' }
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

  useEffect(() => {
    loadKeys().then(setKeys);
    detectTv().then(setDeviceIsTv);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('tv', tv);
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
        {current.kind === 'search' && <Search keys={keys} onBack={back} open={(v) => push({ kind: 'player', video: v })} />}
        {current.kind === 'settings' && (
          <Settings keys={keys} onBack={back} editKeys={() => push({ kind: 'setup' })} onTvModeChange={setTvPref} deviceIsTv={deviceIsTv} />
        )}
      </>
    );
  }
  return <TvContext.Provider value={tv}>{content}</TvContext.Provider>;
}
