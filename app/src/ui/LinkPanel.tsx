import { useState } from 'react';
import type { ApiKeys } from '../lib/keys.ts';
import { linkedTv, linkServerInfo, linkWithCode, newPairingCode, pairingCode, sendToTv, unlinkTv } from '../lib/link.ts';
import { getTold, mergeTold } from '../lib/wander.ts';

/** On the TV: shows the pairing code. */
export function TvLinkPanel() {
  const [code, setCode] = useState(pairingCode());
  const info = linkServerInfo();
  return (
    <section className="panel">
      <h3>Link a phone</h3>
      <p className="muted small">
        Use Wander on your phone as this TV’s microphone and keyboard: on the phone, open Settings → Link to TV and enter this code. Both need to be on
        the same Wi-Fi, with Wander open on the TV.
      </p>
      <div className="code-big">{code}</div>
      <p className="muted small">{info ? `Listening on ${info.addresses.join(', ') || 'this network'} (port ${info.port}).` : 'Starting…'}</p>
      <button className="btn btn-ghost" onClick={() => setCode(newPairingCode())}>
        New code (unlinks old phones)
      </button>
    </section>
  );
}

/** On the phone: link to a TV, then send keys and sync. */
export function PhoneLinkPanel({ keys }: { keys: ApiKeys }) {
  const [tv, setTv] = useState(linkedTv());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setStatus('');
    try {
      setStatus(await fn());
    } catch (e) {
      setStatus(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h3>Link to TV</h3>
      {!tv ? (
        <>
          <p className="muted small">
            Talk to Wander on your TV through this phone, and send it your keys. On the TV, open Wander → Settings → Link a phone to see the code.
          </p>
          <div className="end-actions left">
            <input
              className="code-input"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6-digit code"
            />
            <button
              className="btn"
              disabled={busy || code.length !== 6}
              onClick={() =>
                run(async () => {
                  const t = await linkWithCode(code, setStatus);
                  setTv(t);
                  const synced = await sendToTv({ type: 'sync', told: getTold() }).catch(() => null);
                  if (synced?.told) mergeTold(synced.told);
                  return `✓ Linked to the TV at ${t.host}.`;
                })
              }
            >
              {busy ? 'Linking…' : 'Link'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="small">
            Linked to the TV at {tv.host}. In ✦ Ask, choose “📺 TV” to send what you say there.
          </p>
          <div className="end-actions left">
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await sendToTv({ type: 'keys', youtube: keys.youtube, anthropic: keys.anthropic, anthropicWorkspace: keys.anthropicWorkspace });
                  return '✓ Keys sent. The TV is ready to use.';
                })
              }
            >
              Send my API keys to the TV
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await sendToTv({ type: 'sync', told: getTold() });
                  if (r?.told) mergeTold(r.told);
                  return '✓ Rows, interests and rules are the same on both.';
                })
              }
            >
              Sync rows, interests and rules
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await sendToTv({ type: 'newSet' });
                  return '✓ The TV is showing a new set.';
                })
              }
            >
              New set on the TV
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                unlinkTv();
                setTv(null);
                setStatus('Unlinked.');
              }}
            >
              Unlink
            </button>
          </div>
        </>
      )}
      {status && <p className="small">{status}</p>}
    </section>
  );
}
