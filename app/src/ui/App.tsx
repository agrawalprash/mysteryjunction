import { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import type { Candidate } from '../engine/types.ts';
import { loadKeys, type ApiKeys } from '../lib/keys.ts';
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

export function App() {
  const [keys, setKeys] = useState<ApiKeys | null>(null);
  const [stack, setStack] = useState<Screen[]>([{ kind: 'home' }]);
  const stackRef = useRef(stack);
  stackRef.current = stack;

  useEffect(() => {
    loadKeys().then(setKeys);
  }, []);

  const push = useCallback((s: Screen) => setStack((st) => [...st, s]), []);
  const back = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)), []);
  const replace = useCallback((s: Screen) => setStack((st) => [...st.slice(0, -1), s]), []);

  // Android back button walks back through screens, then leaves the app.
  useEffect(() => {
    const handle = CapApp.addListener('backButton', () => {
      if (stackRef.current.length > 1) back();
      else CapApp.minimizeApp();
    });
    return () => {
      handle.then((h) => h.remove());
    };
  }, [back]);

  if (!keys) return <div className="splash">Wander</div>;

  const current = stack[stack.length - 1];
  const needsSetup = !keys.youtube;

  if (needsSetup || current.kind === 'setup') {
    return (
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
  }

  return (
    <>
      {/* Home stays mounted underneath so its scroll position survives. */}
      <div style={{ display: current.kind === 'home' ? 'block' : 'none' }}>
        <Home keys={keys} open={(v) => push({ kind: 'player', video: v })} go={push} visible={current.kind === 'home'} />
      </div>
      {current.kind === 'player' && (
        <Player key={current.video.id} video={current.video} onBack={back} open={(v) => replace({ kind: 'player', video: v })} />
      )}
      {current.kind === 'search' && <Search keys={keys} onBack={back} open={(v) => push({ kind: 'player', video: v })} />}
      {current.kind === 'settings' && <Settings keys={keys} onBack={back} editKeys={() => push({ kind: 'setup' })} />}
    </>
  );
}
