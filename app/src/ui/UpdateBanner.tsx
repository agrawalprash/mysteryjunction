import { useEffect, useState } from 'react';
import { checkForUpdate, installUpdate, type UpdateInfo } from '../lib/updater.ts';

/** Shows "Update available" with a one-tap install, when there's a newer release. */
export function UpdateBanner({ force = false, showLatest = false }: { force?: boolean; showLatest?: boolean }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checked, setChecked] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    checkForUpdate(force)
      .then(setInfo)
      .catch((e) => force && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setChecked(true));
  }, [force]);

  const go = async () => {
    if (!info) return;
    setError('');
    setStatus('Downloading… 0%');
    try {
      const result = await installUpdate(info, (p) => setStatus(`Downloading… ${p}%`));
      setStatus(
        result === 'needs-permission'
          ? 'Android needs your OK first: turn on “Allow from this source” for Wander, come back, and press Update again.'
          : 'Follow Android’s prompt to install. Your keys and history stay.',
      );
    } catch (e) {
      setStatus('');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!info) {
    if (showLatest && checked) return <p className="muted small">{error || 'You have the latest version.'}</p>;
    return null;
  }
  return (
    <div className="update-banner">
      <div>
        <strong>Update available</strong> <span className="muted">{info.name}</span>
        {info.notes && <p className="muted small update-notes">{info.notes}</p>}
        {status && <p className="small">{status}</p>}
        {error && <p className="small error-text">{error}</p>}
      </div>
      <button className="btn" onClick={go} disabled={status.startsWith('Downloading')}>
        Update
      </button>
    </div>
  );
}
