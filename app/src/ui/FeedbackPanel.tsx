import { useState } from 'react';
import { saveKeys, type ApiKeys } from '../lib/keys.ts';

/** GitHub token for sending app feedback to Claude, plus how to make one. */
export function FeedbackPanel({ keys, onKeys, openFeedback }: { keys: ApiKeys; onKeys: (k: ApiKeys) => void; openFeedback: () => void }) {
  const [token, setToken] = useState(keys.github ?? '');
  const [status, setStatus] = useState('');
  return (
    <section className="panel">
      <h3>💬 Feedback to Claude</h3>
      <p className="muted small">
        Speak or type what should change in Wander; it goes to the Claude session that builds the app, which replies in the app and ships a new version
        (you’ll get a pop-up). Needs a GitHub token once.
      </p>
      <button className="btn" onClick={openFeedback} disabled={!keys.github}>
        Give feedback
      </button>
      <details>
        <summary className="small">{keys.github ? 'GitHub token (saved)' : 'Add a GitHub token'}</summary>
        <ol className="small">
          <li>On github.com: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.</li>
          <li>Repository access: Only select repositories → mysteryjunction.</li>
          <li>Permissions → Repository: Issues “Read and write”, Pull requests “Read and write”.</li>
          <li>Generate, copy, and paste it here. It’s stored encrypted on this device; “Send my API keys to the TV” also sends it.</li>
        </ol>
        <div className="end-actions left">
          <input className="code-input token-input" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" spellCheck={false} />
          <button
            className="btn btn-ghost"
            onClick={async () => {
              const next = { ...keys, github: token.trim() };
              await saveKeys(next);
              onKeys(next);
              setStatus(token.trim() ? '✓ Saved.' : 'Removed.');
            }}
          >
            Save
          </button>
        </div>
        {status && <p className="small">{status}</p>}
      </details>
    </section>
  );
}
