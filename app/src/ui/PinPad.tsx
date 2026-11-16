import { useEffect, useState } from 'react';
import { answerPin, onPinRequest, pinRequest } from '../lib/pinGate.ts';
import { focusFirst } from '../lib/spatialNav.ts';
import { setOverlayCloser } from '../lib/overlay.ts';

/** The parent PIN pad, shown over everything when something asks for it. */
export function PinPad({ tv }: { tv: boolean }) {
  const [, rerender] = useState(0);
  const [digits, setDigits] = useState('');
  const [wrong, setWrong] = useState(false);
  useEffect(() => onPinRequest(() => rerender((n) => n + 1)), []);
  const req = pinRequest();

  useEffect(() => {
    if (!req) return;
    setDigits('');
    setWrong(false);
    setOverlayCloser(() => answerPin(null));
    if (tv) window.setTimeout(() => focusFirst('.pin-pad'), 60);
    return () => setOverlayCloser(null);
  }, [req, tv]);

  if (!req) return null;

  const press = (d: string) => {
    setWrong(false);
    const next = (digits + d).slice(0, 4);
    setDigits(next);
    if (next.length === 4 && !answerPin(next)) {
      setWrong(true);
      setDigits('');
    }
  };

  return (
    <div className="sheet-backdrop pin-backdrop">
      <div className="sheet pin-sheet" role="dialog" aria-label="Grown-up PIN">
        <h2>Grown-ups only</h2>
        <p className="muted small">{req.reason}</p>
        <div className="pin-dots" aria-label={`${digits.length} of 4 digits`}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`pin-dot${i < digits.length ? ' pin-dot-on' : ''}`} />
          ))}
        </div>
        {wrong && <p className="small error-text">That’s not it. Try again.</p>}
        <div className="pin-pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} className="btn btn-ghost" onClick={() => press(d)}>
              {d}
            </button>
          ))}
          <button className="btn btn-ghost" onClick={() => answerPin(null)}>
            Cancel
          </button>
          <button className="btn btn-ghost" onClick={() => press('0')}>
            0
          </button>
          <button className="btn btn-ghost" aria-label="Delete" onClick={() => setDigits((x) => x.slice(0, -1))}>
            ⌫
          </button>
        </div>
      </div>
    </div>
  );
}
