import { useState } from 'react';
import { saveKeys, type ApiKeys } from '../lib/keys.ts';
import { testKey as testYouTube } from '../lib/youtube.ts';
import { testKey as testClaude } from '../lib/claude.ts';

export function Setup({
  initial,
  canCancel,
  onDone,
  onCancel,
}: {
  initial: ApiKeys;
  canCancel: boolean;
  onDone: (k: ApiKeys) => void;
  onCancel: () => void;
}) {
  const [youtube, setYoutube] = useState(initial.youtube);
  const [anthropic, setAnthropic] = useState(initial.anthropic);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const keys = { youtube: youtube.trim(), anthropic: anthropic.trim() };
    try {
      try {
        await testYouTube(keys.youtube);
      } catch (err) {
        throw new Error(`The YouTube key didn’t work: ${err instanceof Error ? err.message : err}`);
      }
      if (keys.anthropic) {
        try {
          await testClaude(keys.anthropic);
        } catch (err) {
          throw new Error(`The Anthropic key didn’t work: ${err instanceof Error ? err.message : err}`);
        }
      }
      await saveKeys(keys);
      onDone(keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen setup">
      <h1>
        <span className="logo-mark">▶</span> Wander
      </h1>
      <p className="muted">YouTube, with a feed that keeps surprising you. One-time setup: paste two keys. They’re saved in your phone’s encrypted storage and never leave the device except to talk to YouTube and Anthropic.</p>

      <form onSubmit={submit}>
        <label>
          YouTube Data API key <span className="muted">(required)</span>
          <input value={youtube} onChange={(e) => setYoutube(e.target.value)} placeholder="AIza…" autoComplete="off" spellCheck={false} />
        </label>
        <details>
          <summary>How do I get this?</summary>
          <ol>
            <li>Open console.cloud.google.com and sign in with your Google account.</li>
            <li>Create a project (any name, e.g. “Wander”).</li>
            <li>Search for “YouTube Data API v3” in the top bar, open it, tap Enable.</li>
            <li>Go to APIs &amp; Services → Credentials → Create credentials → API key.</li>
            <li>Edit the key → API restrictions → Restrict key → choose only “YouTube Data API v3” → Save.</li>
            <li>Copy the key and paste it here. It’s free; no billing needed.</li>
          </ol>
        </details>

        <label>
          Anthropic API key <span className="muted">(optional, recommended)</span>
          <input value={anthropic} onChange={(e) => setAnthropic(e.target.value)} placeholder="sk-ant-…" autoComplete="off" spellCheck={false} />
        </label>
        <p className="muted small">Lets Claude choose more inventive topic jumps each day. About a few cents a day. Without it, Wander uses a built-in topic list.</p>

        {error && <div className="error-box"><p>{error}</p></div>}
        <div className="setup-actions">
          {canCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button className="btn" disabled={busy || !youtube.trim()}>
            {busy ? 'Checking keys…' : 'Save and start'}
          </button>
        </div>
      </form>
    </div>
  );
}
