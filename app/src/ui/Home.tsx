import { useCallback, useEffect, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import type { Candidate, DailyFeed } from '../engine/types.ts';
import type { ApiKeys } from '../lib/keys.ts';
import { buildTodaysFeed, getState, newSet, setsLeftToday, surprise, SURPRISES_PER_DAY, todaysFeed } from '../lib/wander.ts';
import { VideoCard } from './VideoCard.tsx';
import { useTv, type Screen } from './App.tsx';
import { focusFirst } from '../lib/spatialNav.ts';
import { onVoiceKey } from '../lib/voice.ts';
import { setOverlayCloser } from '../lib/overlay.ts';
import { AskSheet } from './AskSheet.tsx';
import { UpdateBanner } from './UpdateBanner.tsx';

export function Home({ keys, open, go, visible }: { keys: ApiKeys; open: (v: Candidate) => void; go: (s: Screen) => void; visible: boolean }) {
  const [feed, setFeed] = useState<DailyFeed | null>(todaysFeed());
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<Set<string>>(new Set(getState().opened));
  const [asking, setAsking] = useState<null | { voice: boolean }>(null);
  const tv = useTv();

  const closeAsk = useCallback(() => {
    setAsking(null);
    setOverlayCloser(null);
  }, []);
  const openAsk = useCallback(
    (voice: boolean) => {
      setAsking({ voice });
      setOverlayCloser(() => setAsking(null));
    },
    [],
  );

  // The remote's mic button (when it reaches the app) opens Ask Wander and starts listening.
  useEffect(() => {
    if (!visible) return;
    return onVoiceKey(() => openAsk(true));
  }, [visible, openAsk]);

  const showNewFeed = (f: DailyFeed) => {
    setFeed(f);
    setOpened(new Set(getState().opened));
    window.scrollTo({ top: 0 });
    if (tv) window.setTimeout(() => focusFirst('.row .card'), 80);
  };

  // On TV, once the feed arrives, start on the first video instead of the header.
  useEffect(() => {
    if (!tv || !feed || !visible) return;
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('.topbar')) focusFirst('.row .card');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tv, feed]);

  const load = useCallback(async () => {
    if (todaysFeed()) {
      setFeed(todaysFeed());
      return;
    }
    setBusy(true);
    setError('');
    try {
      setFeed(await buildTodaysFeed(keys, setProgress));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress('');
    }
  }, [keys]);

  useEffect(() => {
    load();
  }, [load]);

  // A new day starts a new feed, even if the app was left open overnight.
  useEffect(() => {
    const h = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive && !todaysFeed()) load();
    });
    return () => {
      h.then((x) => x.remove());
    };
  }, [load]);

  // Coming back from the player: refresh watched marks and any hidden channels.
  useEffect(() => {
    if (visible) {
      setOpened(new Set(getState().opened));
      if (todaysFeed()) setFeed(todaysFeed());
      else if (!busy) load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const doNewSet = async () => {
    setBusy(true);
    setError('');
    try {
      showNewFeed(await newSet(keys, '', setProgress));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const doSurprise = async () => {
    setBusy(true);
    setError('');
    try {
      setFeed(await surprise(keys, setProgress));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const surprisesLeft = feed ? SURPRISES_PER_DAY - feed.surprisesUsed : 0;

  return (
    <div className="screen home">
      <header className="topbar">
        <div className="logo">
          <span className="logo-mark">✦</span> Wander
        </div>
        <div className="topbar-actions">
          {keys.anthropic && (
            <button className="ask-btn" onClick={() => openAsk(false)}>
              ✦ Ask
            </button>
          )}
          <button className="icon-btn" aria-label="Search" onClick={() => go({ kind: 'search' })}>
            <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16a6.47 6.47 0 0 0 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14" /></svg>
          </button>
          <button className="icon-btn" aria-label="Settings" onClick={() => go({ kind: 'settings' })}>
            <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.61.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.49.42h3.84c.24 0 .45-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2" /></svg>
          </button>
        </div>
      </header>

      <UpdateBanner />

      {!feed && busy && (
        <div className="loading">
          <div className="spinner" />
          <p>{progress || 'Planning your picks…'}</p>
          <p className="muted small">The first set takes about half a minute. After that, the next one is prepared in the background.</p>
        </div>
      )}
      {feed && busy && (
        <div className="busy-strip">
          <div className="spinner small-spinner" /> {progress || 'Working…'}
        </div>
      )}

      {error && (
        <div className="error-box">
          <p>{error}</p>
          {!feed && (
            <button className="btn" onClick={load}>
              Try again
            </button>
          )}
        </div>
      )}

      {feed && (
        <main>
          {feed.plannerNote && <p className="planner-note">{feed.plannerNote}</p>}
          {feed.rows.length === 0 && <p className="muted planner-note">Nothing matched this time. Try a new set or ask for something.</p>}
          {feed.rows.map((row) => (
            <section key={row.id} className="row">
              <h2>{row.title}</h2>
              <p className="row-sub">{row.subtitle}</p>
              <div className="row-scroll">
                {row.items.map((v) => (
                  <VideoCard key={v.id} video={v} onOpen={open} watched={row.id !== 'again' && opened.has(v.id)} />
                ))}
              </div>
            </section>
          ))}

          {feed.shorts.length > 0 && (
            <section className="row">
              <h2>Shorts</h2>
              <p className="row-sub">Ten quick ones for today</p>
              <div className="row-scroll">
                {feed.shorts.map((v) => (
                  <VideoCard key={v.id} video={v} onOpen={open} variant="short" watched={opened.has(v.id)} />
                ))}
              </div>
            </section>
          )}

          <section className="the-end">
            <div className="the-end-mark">✦</div>
            <h3>That’s this set</h3>
            <p className="muted">Wander learns from what you watch, so there’s nothing to rate. Want something else? Ask, or get a new set.</p>
            <div className="end-actions">
              {setsLeftToday() > 0 ? (
                <button className="btn" disabled={busy} onClick={doNewSet}>
                  New set ({setsLeftToday()} left today)
                </button>
              ) : (
                <p className="muted small">No new sets left today (YouTube’s daily limit).</p>
              )}
              {keys.anthropic && (
                <button className="btn btn-ghost" disabled={busy} onClick={() => openAsk(false)}>
                  ✦ Ask Wander
                </button>
              )}
              {surprisesLeft > 0 && (
                <button className="btn btn-ghost" disabled={busy} onClick={doSurprise}>
                  Surprise me ({surprisesLeft})
                </button>
              )}
            </div>
          </section>
        </main>
      )}

      {asking && <AskSheet keys={keys} startWithVoice={asking.voice} onClose={closeAsk} onFeed={showNewFeed} />}
    </div>
  );
}
