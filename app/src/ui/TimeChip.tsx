import { useEffect, useState } from 'react';
import { onTimeChanged, timeStatus } from '../lib/screenTime.ts';

/** How much TV time is left today, as an hourglass and blocks (profiles with the timer on). */
export function TimeChip() {
  const [, tick] = useState(0);
  useEffect(() => onTimeChanged(() => tick((n) => n + 1)), []);
  const t = timeStatus();
  if (!t.on) return null;
  const left = Math.max(0, Math.ceil(t.leftSec / 60));
  const blocks = 6;
  const full = Math.round((Math.max(0, t.leftSec) / (t.budgetMin * 60)) * blocks);
  return (
    <div className="time-chip" aria-label={`${left} minutes of TV left today`}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 2h12M6 22h12M7 2c0 5 10 5 10 10S7 17 7 22M17 2c0 5-10 5-10 10s10 5 10 10" />
      </svg>
      <span>{left} min</span>
      <span className="time-blocks" aria-hidden="true">
        {Array.from({ length: blocks }, (_, i) => (
          <span key={i} className={i < full ? 'on' : ''} />
        ))}
      </span>
    </div>
  );
}
