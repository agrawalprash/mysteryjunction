import { useState } from 'react';
import type { ApiKeys } from '../lib/keys.ts';
import { currentProfile, resetLearning } from '../lib/wander.ts';
import { DiagnosePanel } from './DiagnosePanel.tsx';
import { PhoneLinkPanel, TvLinkPanel } from './LinkPanel.tsx';
import { FeedbackPanel } from './FeedbackPanel.tsx';
import { FEEDBACK_ENABLED } from '../lib/feedback.ts';
import { FeedbackSheet } from './FeedbackSheet.tsx';
import { setOverlayCloser } from '../lib/overlay.ts';
import { useTv } from './App.tsx';
import { getSettings, LANGUAGES, updateSettings, type Settings as Prefs } from '../lib/settings.ts';
import { ProfilesPanel } from './Profiles.tsx';

declare const __APP_VERSION__: string;

export function Settings({
  keys,
  onBack,
  editKeys,
  onTvModeChange,
  deviceIsTv,
  onKeys,
  openReport,
}: {
  keys: ApiKeys;
  onBack: () => void;
  editKeys: () => void;
  onTvModeChange: (m: Prefs['tvMode']) => void;
  deviceIsTv: boolean;
  onKeys: (k: ApiKeys) => void;
  openReport: () => void;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [, force] = useState(0);
  const tv = useTv();
  const [prefs, setPrefs] = useState(getSettings());

  const set = (patch: Partial<Prefs>) => {
    const next = updateSettings(patch);
    setPrefs(next);
    if (patch.tvMode) onTvModeChange(patch.tvMode);
  };

  return (
    <div className="screen settings">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
        <div className="topbar-title">Settings</div>
      </header>

      <ProfilesPanel onSwitched={() => force((n) => n + 1)} />

      {!tv && (
        <section className="panel">
          <h3>Profile reports</h3>
          <p className="muted small">What each profile is into, Claude’s read, and the instructions Claude follows for them.</p>
          <button className="btn" onClick={openReport}>
            Open reports
          </button>
        </section>
      )}

      {tv ? <TvLinkPanel /> : <PhoneLinkPanel keys={keys} />}

      {FEEDBACK_ENABLED && (
        <FeedbackPanel
          keys={keys}
          onKeys={onKeys}
          openFeedback={() => {
            setFeedbackOpen(true);
            setOverlayCloser(() => setFeedbackOpen(false));
          }}
        />
      )}

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
        {!tv && (
          <label className="field">
            <span>Open in TV remote mode when linked</span>
            <select value={prefs.remoteOnStart ? 'on' : 'off'} onChange={(e) => set({ remoteOnStart: e.target.value === 'on' })}>
              <option value="on">Yes</option>
              <option value="off">No</option>
            </select>
          </label>
        )}
      </section>

      <DiagnosePanel keys={keys} />

      <section className="panel">
        <h3>Keys</h3>
        <button className="btn btn-ghost" onClick={editKeys}>
          Change API keys
        </button>
      </section>

      <section className="panel">
        <h3>Start over</h3>
        <p className="muted small">Forget everything Wander has learned for {currentProfile().name} (interests, history, taste, instructions). Other profiles and keys are kept.</p>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm(`Forget everything Wander has learned for ${currentProfile().name}?`)) {
              resetLearning();
              force((n) => n + 1);
            }
          }}
        >
          Reset learning
        </button>
      </section>

      <p className="muted small version">Wander {__APP_VERSION__}</p>
      {feedbackOpen && (
        <FeedbackSheet
          keys={keys}
          onClose={() => {
            setFeedbackOpen(false);
            setOverlayCloser(null);
          }}
        />
      )}
    </div>
  );
}
