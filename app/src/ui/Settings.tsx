import { useState } from 'react';
import type { ApiKeys } from '../lib/keys.ts';
import { getState, rebuildToday, resetLearning } from '../lib/wander.ts';
import { DAILY_QUOTA, quotaUsed } from '../lib/youtube.ts';
import { rankTopics } from '../engine/profile.ts';

declare const __APP_VERSION__: string;

export function Settings({ keys, onBack, editKeys }: { keys: ApiKeys; onBack: () => void; editKeys: () => void }) {
  const [, force] = useState(0);
  const st = getState();
  const topics = rankTopics(st.profile, Date.now()).slice(0, 40);
  const maxAbs = Math.max(0.01, ...topics.map((t) => Math.abs(t.score)));

  return (
    <div className="screen settings">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
        <div className="topbar-title">Settings</div>
      </header>

      <section className="panel">
        <h3>What Wander thinks you like</h3>
        <p className="muted small">Learned from what you watch and skip. Bars to the right are interests; to the left, things that didn’t land. Recently binged topics rest for a few days.</p>
        {topics.length === 0 && <p className="muted">Nothing yet. Watch a few things.</p>}
        <ul className="topic-map">
          {topics.map((t) => (
            <li key={t.name}>
              <span className="topic-name">
                {t.name}
                {t.freshness < 0.9 && <span className="tag">resting</span>}
                {t.origin !== 'core' && t.origin !== 'search' && t.score >= 0.35 && <span className="tag tag-new">new interest</span>}
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
      </section>

      <section className="panel">
        <h3>Today</h3>
        <p>
          YouTube quota used: {quotaUsed().toLocaleString()} / {DAILY_QUOTA.toLocaleString()}
        </p>
        <p className="muted small">Videos watched so far: {st.history.length}. Claude planner: {keys.anthropic ? 'on' : 'off (no key)'}.</p>
        <button
          className="btn btn-ghost"
          onClick={() => {
            if (confirm('Throw away today’s feed and build a new one? Uses about a fifth of today’s YouTube quota.')) {
              rebuildToday();
              onBack();
            }
          }}
        >
          Rebuild today’s feed
        </button>
      </section>

      <section className="panel">
        <h3>Keys</h3>
        <button className="btn btn-ghost" onClick={editKeys}>
          Change API keys
        </button>
      </section>

      <section className="panel">
        <h3>Start over</h3>
        <p className="muted small">Forget everything Wander has learned (interests, history, hidden channels). Keys are kept.</p>
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
