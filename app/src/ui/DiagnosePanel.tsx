import { useState } from 'react';
import type { ApiKeys } from '../lib/keys.ts';
import { DEFAULT_SYMPTOMS, runDiagnosis, type DiagnosisRun } from '../lib/diagnostics.ts';

/** Collects facts about this device's voice setup and asks Claude what's wrong. */
export function DiagnosePanel({ keys }: { keys: ApiKeys }) {
  const [symptoms, setSymptoms] = useState(DEFAULT_SYMPTOMS);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<DiagnosisRun | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await runDiagnosis(keys, symptoms, setProgress));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const d = result?.diagnosis;
  return (
    <section className="panel">
      <h3>Diagnose voice problems with Claude</h3>
      <p className="muted small">
        Wander checks this device’s voice setup (speech apps, permissions, default assistant, remotes, whether Google’s servers are reachable on
        your network) and runs a short live speech test. Claude then explains what’s most likely wrong. Nothing is changed on the device.
      </p>
      <label className="small muted">What’s happening (edit if needed)</label>
      <textarea value={symptoms} onChange={(e) => setSymptoms(e.target.value)} disabled={busy} />
      <div className="end-actions left">
        <button className="btn" onClick={run} disabled={busy || !keys.anthropic}>
          {busy ? progress || 'Working…' : 'Diagnose'}
        </button>
      </div>
      {!keys.anthropic && <p className="muted small">Needs an Anthropic key.</p>}
      {error && <p className="small error-text">{error}</p>}
      {d && (
        <div className="diagnosis">
          <p>
            <strong>{d.summary}</strong>
          </p>
          <ul className="diag-findings">
            {d.findings.map((f) => (
              <li key={f.cause}>
                <span className={`likelihood likelihood-${f.likelihood.split(' ')[0]}`}>{f.likelihood}</span>
                <strong>{f.cause}</strong>
                <div className="muted small">{f.evidence}</div>
              </li>
            ))}
          </ul>
          {d.steps.length > 0 && (
            <>
              <h4>Try next</h4>
              <ol>
                {d.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </>
          )}
          {d.needs_from_viewer && <p className="small">{d.needs_from_viewer}</p>}
          <details>
            <summary className="small">What Wander collected</summary>
            <pre className="raw">{JSON.stringify(result.report, null, 1)}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
