import { useEffect, useState } from 'react';
import type { ApiKeys } from '../lib/keys.ts';
import { forget, getState, maybeRefreshTaste, resetLearning } from '../lib/wander.ts';
import { listen, onVoiceKey, voiceAvailable } from '../lib/voice.ts';
import { UpdateBanner } from './UpdateBanner.tsx';
import { DAILY_QUOTA, quotaUsed } from '../lib/youtube.ts';
import { getSettings, LANGUAGES, updateSettings, type Settings as Prefs } from '../lib/settings.ts';
import { rankTopics } from '../engine/profile.ts';

declare const __APP_VERSION__: string;

/** Finds out whether the remote's mic button and voice input reach Wander. */
function RemoteTest() {
  const [keyResult, setKeyResult] = useState('');
  const [voiceResult, setVoiceResult] = useState('');
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!waiting) return;
    const seen = (what: string) => {
      setKeyResult(what);
      setWaiting(false);
    };
    const stopVoice = onVoiceKey((code) => seen(`✓ The mic button reached Wander (key code ${code}). Pressing it on the home screen will start voice input.`));
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return;
      seen(`Got a different button: “${e.key}” (code ${e.keyCode}). If that was the mic button, tell Claude this code.`);
    };
    window.addEventListener('keydown', onKey, true);
    const t = window.setTimeout(
      () => seen('✗ Nothing arrived in 10 seconds. The remote’s mic button is probably taken over by the system (or the remote’s mic isn’t paired). Use the Speak button in Ask Wander instead.'),
      10_000,
    );
    return () => {
      stopVoice();
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(t);
    };
  }, [waiting]);

  const testVoice = async () => {
    setVoiceResult('Listening… say anything.');
    try {
      const text = await listen('Say anything to test voice input');
      setVoiceResult(text ? `✓ Heard: “${text}”` : 'Heard nothing. Try again closer to the mic.');
    } catch (e) {
      setVoiceResult(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <section className="panel">
      <h3>Remote and voice test</h3>
      <p className="muted small">Checks whether your remote’s mic button reaches Wander, and whether this device can turn speech into text.</p>
      <div className="end-actions left">
        <button className="btn btn-ghost" disabled={waiting} onClick={() => { setKeyResult(''); setWaiting(true); }}>
          {waiting ? 'Press the mic button now…' : '1. Test the mic button'}
        </button>
        <button className="btn btn-ghost" onClick={testVoice} disabled={!voiceAvailable()}>
          2. Test voice input
        </button>
      </div>
      {keyResult && <p className="small">{keyResult}</p>}
      {voiceResult && <p className="small">{voiceResult}</p>}
      {!voiceAvailable() && <p className="muted small">Voice only works in the installed app.</p>}
    </section>
  );
}

function Bars({ items }: { items: { name: string; score: number; freshness?: number; tag?: string }[] }) {
  const maxAbs = Math.max(0.01, ...items.map((t) => Math.abs(t.score)));
  return (
    <ul className="topic-map">
      {items.map((t) => (
        <li key={t.name}>
          <span className="topic-name">
            {t.name}
            {t.freshness !== undefined && t.freshness < 0.9 && <span className="tag">resting</span>}
            {t.tag && <span className="tag tag-new">{t.tag}</span>}
          </span>
          <span className="bar-track">
            <span
              className={`bar ${t.score >= 0 ? 'bar-pos' : 'bar-neg'}`}
              style={{ width: `${(Math.abs(t.score) / maxAbs) * 50}%`, [t.score >= 0 ? 'left' : 'right']: '50%' }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Settings({
  keys,
  onBack,
  editKeys,
  onTvModeChange,
  deviceIsTv,
}: {
  keys: ApiKeys;
  onBack: () => void;
  editKeys: () => void;
  onTvModeChange: (m: Prefs['tvMode']) => void;
  deviceIsTv: boolean;
}) {
  const [, force] = useState(0);
  const [prefs, setPrefs] = useState(getSettings());
  const [tasteBusy, setTasteBusy] = useState(false);
  const [tasteError, setTasteError] = useState('');
  const st = getState();
  const now = Date.now();
  const topics = rankTopics(st.profile, now)
    .slice(0, 40)
    .map((t) => ({
      ...t,
      tag: t.origin !== 'core' && t.origin !== 'search' && t.score >= 0.35 ? 'new interest' : undefined,
    }));
  const facets = rankTopics(st.facetProfile, now)
    .filter((t) => Math.abs(t.score) > 0.05)
    .map((t) => ({ name: t.name.replace(':', ': '), score: t.score }));
  const taste = st.taste;

  const set = (patch: Partial<Prefs>) => {
    const next = updateSettings(patch);
    setPrefs(next);
    if (patch.tvMode) onTvModeChange(patch.tvMode);
  };

  const refreshTaste = async () => {
    setTasteBusy(true);
    setTasteError('');
    try {
      await maybeRefreshTaste(keys, true);
    } catch (e) {
      setTasteError(e instanceof Error ? e.message : String(e));
    } finally {
      setTasteBusy(false);
    }
  };

  return (
    <div className="screen settings">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
        <div className="topbar-title">Settings</div>
      </header>

      <section className="panel">
        <h3>Claude’s read on your taste</h3>
        {!keys.anthropic && <p className="muted small">Add an Anthropic key to get this.</p>}
        {keys.anthropic && !taste && (
          <p className="muted small">Written once you’ve watched a few videos, then refreshed weekly. It shapes every daily plan.</p>
        )}
        {taste && (
          <div className="taste">
            <p>{taste.summary}</p>
            {taste.loves.length > 0 && (
              <p>
                <strong>Loves:</strong> {taste.loves.join(' · ')}
              </p>
            )}
            {taste.curiousAbout.length > 0 && (
              <p>
                <strong>Curious about:</strong> {taste.curiousAbout.join(' · ')}
              </p>
            )}
            {taste.formatsLiked.length > 0 && (
              <p>
                <strong>Formats that land:</strong> {taste.formatsLiked.join(' · ')}
              </p>
            )}
            {taste.avoid.length > 0 && (
              <p>
                <strong>Not for you:</strong> {[...taste.avoid, ...taste.formatsDisliked].join(' · ')}
              </p>
            )}
            <p className="muted small">Written {new Date(taste.generatedAt).toLocaleDateString('en-GB')} from {taste.watchesSeen} watched videos.</p>
          </div>
        )}
        {keys.anthropic && (
          <button className="btn btn-ghost" disabled={tasteBusy} onClick={refreshTaste}>
            {tasteBusy ? 'Claude is reading your history…' : taste ? 'Rewrite now' : 'Write it now'}
          </button>
        )}
        {tasteError && <p className="muted small">{tasteError}</p>}
      </section>

      <section className="panel">
        <h3>What you’ve told Wander</h3>
        {st.customRows.length + st.pinned.length + st.rules.length === 0 ? (
          <p className="muted small">Nothing yet. Use ✦ Ask to add rows (“add a row for live jazz”), lasting interests or rules.</p>
        ) : (
          <ul className="told">
            {st.customRows.map((r) => (
              <li key={r.id}>
                <span><span className="tag">row</span> {r.title}</span>
                <button className="chip" onClick={() => { forget('row', r.id); force((n) => n + 1); }}>Remove</button>
              </li>
            ))}
            {st.pinned.map((p) => (
              <li key={p}>
                <span><span className="tag">interest</span> {p}</span>
                <button className="chip" onClick={() => { forget('interest', p); force((n) => n + 1); }}>Remove</button>
              </li>
            ))}
            {st.rules.map((p) => (
              <li key={p}>
                <span><span className="tag">rule</span> {p}</span>
                <button className="chip" onClick={() => { forget('rule', p); force((n) => n + 1); }}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h3>What Wander has learned</h3>
        <p className="muted small">From what you watch and skip. Bars to the right are interests; to the left, things that didn’t land. Recently binged topics rest for a few days.</p>
        {topics.length === 0 ? <p className="muted">Nothing yet. Watch a few things.</p> : <Bars items={topics} />}
        {facets.length > 0 && (
          <>
            <h4>Kinds of video</h4>
            <Bars items={facets} />
          </>
        )}
      </section>

      <section className="panel">
        <h3>Display</h3>
        <label className="field">
          <span>TV layout</span>
          <select value={prefs.tvMode} onChange={(e) => set({ tvMode: e.target.value as Prefs['tvMode'] })}>
            <option value="auto">Automatic ({deviceIsTv ? 'this is a TV' : 'this is not a TV'})</option>
            <option value="on">Always on</option>
            <option value="off">Always off</option>
          </select>
        </label>
        <label className="field">
          <span>Video language</span>
          <select value={prefs.language} onChange={(e) => set({ language: e.target.value })}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">The language Wander searches in. The app itself is always in English.</p>
      </section>

      <section className="panel">
        <h3>Today</h3>
        <p>
          YouTube quota used: {quotaUsed().toLocaleString('en-US')} / {DAILY_QUOTA.toLocaleString('en-US')}
        </p>
        <p className="muted small">
          Videos watched so far: {st.history.length}. Claude: {keys.anthropic ? 'on' : 'off (no key)'}. Next set {st.prepared ? 'is ready' : 'not prepared yet'}.
        </p>
      </section>

      <section className="panel">
        <h3>Updates</h3>
        <p className="muted small">You have Wander {__APP_VERSION__}.</p>
        <UpdateBanner force showLatest />
      </section>

      <RemoteTest />

      <section className="panel">
        <h3>Keys</h3>
        <button className="btn btn-ghost" onClick={editKeys}>
          Change API keys
        </button>
      </section>

      <section className="panel">
        <h3>Start over</h3>
        <p className="muted small">Forget everything Wander has learned (interests, history, taste profile, hidden channels). Keys are kept.</p>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm('Forget everything Wander has learned?')) {
              resetLearning();
              force((n) => n + 1);
            }
          }}
        >
          Reset learning
        </button>
      </section>

      <p className="muted small version">Wander {__APP_VERSION__}</p>
    </div>
  );
}
