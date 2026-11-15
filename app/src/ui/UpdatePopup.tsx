import { useEffect, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { checkForUpdate, installUpdate, type UpdateInfo } from '../lib/updater.ts';
import { load, save } from '../lib/store.ts';
import { setOverlayCloser } from '../lib/overlay.ts';
import { focusFirst } from '../lib/spatialNav.ts';

/** Checks for a new version every 15 minutes and when you come back to the app; pops up once per version. */
export function UpdatePopup({ tv }: { tv: boolean }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const check = () =>
      checkForUpdate(true)
        .then((i) => {
          // Don't interrupt an open panel (Ask, Feedback…); try again on the next check.
          if (document.querySelector('[role="dialog"]')) return;
          if (i && load<number>('update-dismissed', 0) !== i.versionCode) setInfo(i);
        })
        .catch(() => undefined);
    const first = window.setTimeout(check, 5000);
    const t = window.setInterval(check, 15 * 60 * 1000);
    const h = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) check();
    });
    return () => {
      clearTimeout(first);
      clearInterval(t);
      h.then((x) => x.remove());
    };
  }, []);

  useEffect(() => {
    if (!info) return;
    setOverlayCloser(() => later());
    if (tv) window.setTimeout(() => focusFirst(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  if (!info) return null;

  const later = () => {
    save('update-dismissed', info.versionCode);
    setInfo(null);
    setOverlayCloser(null);
  };

  const go = async () => {
    setStatus('Downloading… 0%');
    try {
      const r = await installUpdate(info, (p) => setStatus(`Downloading… ${p}%`));
      setStatus(r === 'needs-permission' ? 'Allow installs from Wander in the screen that opened, then come back and press Update again.' : 'Confirm the install. Your keys and history stay.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-label="New version">
        <h2>✦ New version ready</h2>
        <p className="muted">{info.name}</p>
        {info.notes && <p className="update-notes">{info.notes}</p>}
        {status && <p className="small">{status}</p>}
        <div className="setup-actions">
          <button className="btn btn-ghost" onClick={later}>
            Later
          </button>
          <button className="btn" onClick={go} disabled={status.startsWith('Downloading')} data-autofocus>
            Update now
          </button>
        </div>
      </div>
    </div>
  );
}
