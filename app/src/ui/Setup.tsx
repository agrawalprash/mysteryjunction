import { useState } from 'react';
import { claudeAuth, saveKeys, type ApiKeys } from '../lib/keys.ts';
import { testKey as testYouTube } from '../lib/youtube.ts';
import { testKey as testClaude } from '../lib/claude.ts';
import { useTv } from './App.tsx';

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
  const tv = useTv();
  const [youtube, setYoutube] = useState(initial.youtube);
  const [anthropic, setAnthropic] = useState(initial.anthropic);
  const [workspace, setWorkspace] = useState(initial.anthropicWorkspace);
  const [showWorkspace, setShowWorkspace] = useState(!!initial.anthropicWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const keys: ApiKeys = { youtube: youtube.trim(), anthropic: anthropic.trim(), anthropicWorkspace: workspace.trim() };
    try {
      try {
        await testYouTube(keys.youtube);
      } catch (err) {
        throw new Error(`The YouTube key didn’t work: ${err instanceof Error ? err.message : err}`);
      }
      const auth = claudeAuth(keys);
      if (auth) {
        try {
          await testClaude(auth);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/workspace/i.test(msg) && !keys.anthropicWorkspace) {
            setShowWorkspace(true);
            throw new Error('This Anthropic key belongs to your whole organization, so it also needs a workspace ID. Fill in the workspace field below and save again.');
          }
          throw new Error(`The Anthropic key didn’t work: ${msg}`);
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
        <span className="logo-mark">✦</span> Wander
      </h1>
      <p className="muted">
        YouTube, with a feed that keeps surprising you. One-time setup: paste your keys. They’re saved in this device’s encrypted storage and only
        used to talk to YouTube and Anthropic.
      </p>
      {tv && (
        <p className="tip">
          Typing keys with a remote is slow. Easier: open the Google TV app on your phone, connect it to this TV, select a field here, then tap the
          keyboard icon in the app and paste the key from your phone.
        </p>
      )}

      <form onSubmit={submit}>
        <label>
          YouTube Data API key <span className="muted">(required)</span>
          <input value={youtube} onChange={(e) => setYoutube(e.target.value)} placeholder="AIza…" autoComplete="off" spellCheck={false} />
        </label>
        <details>
          <summary>How do I get this?</summary>
          <ol>
            <li>Open console.cloud.google.com/apis/library/youtube.googleapis.com and sign in. Create a project if asked (any name).</li>
            <li>Tap Enable.</li>
            <li>Open console.cloud.google.com/apis/credentials → Create credentials → API key.</li>
            <li>Tap the key → API restrictions → Restrict key → only “YouTube Data API v3” → Save.</li>
            <li>Copy the key and paste it here. It’s free; no billing needed.</li>
          </ol>
        </details>

        <label>
          Anthropic API key <span className="muted">(optional, recommended)</span>
          <input value={anthropic} onChange={(e) => setAnthropic(e.target.value)} placeholder="sk-ant-…" autoComplete="off" spellCheck={false} />
        </label>
        <p className="muted small">
          Lets Claude plan each day’s mix, describe videos, and keep a written read of your taste. Roughly 30 cents a day. Without it, Wander uses a
          built-in topic list.
        </p>

        {showWorkspace ? (
          <label>
            Anthropic workspace ID <span className="muted">(only for organization-wide keys)</span>
            <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="wrkspc_…" autoComplete="off" spellCheck={false} />
            <span className="muted small">Find it at platform.claude.com → Settings → Workspaces: open the workspace and copy its ID.</span>
          </label>
        ) : (
          anthropic && (
            <button type="button" className="link-btn" onClick={() => setShowWorkspace(true)}>
              My key needs a workspace ID
            </button>
          )
        )}

        {error && (
          <div className="error-box">
            <p>{error}</p>
          </div>
        )}
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
