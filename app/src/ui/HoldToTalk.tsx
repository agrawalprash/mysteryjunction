import { useEffect, useRef, useState } from 'react';
import { holdCancel, holdStart, holdStop } from '../lib/voice.ts';

/** A walkie-talkie button: hold to speak, see the words as they come, release to send. */
export function HoldToTalk({
  label,
  onSaid,
  disabled = false,
  compact = false,
  onLive,
}: {
  label: string;
  onSaid: (text: string) => void;
  disabled?: boolean;
  /** Just a mic icon (the words show wherever onLive puts them). */
  compact?: boolean;
  /** Words as they're heard, and '' when listening ends. */
  onLive?: (text: string) => void;
}) {
  const [live, setLive] = useState<{ text: string; ready: boolean } | null>(null);
  const [error, setError] = useState('');
  const starting = useRef<Promise<(() => void) | null> | null>(null);

  useEffect(() => () => holdCancel(), []);

  const down = () => {
    if (disabled || starting.current) return;
    setError('');
    setLive({ text: '', ready: false });
    try {
      navigator.vibrate?.(25);
    } catch {
      /* no vibration */
    }
    starting.current = holdStart(
      (text) => {
        setLive((v) => (v ? { ...v, text } : v));
        onLive?.(text);
      },
      () => setLive((v) => (v ? { ...v, ready: true } : v)),
    ).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      setLive(null);
      return null;
    });
  };

  const up = async () => {
    const pending = starting.current;
    if (!pending) return;
    const cleanup = await pending;
    starting.current = null;
    if (!cleanup) return;
    try {
      const said = (await holdStop()).trim();
      setLive(null);
      onLive?.('');
      if (said) onSaid(said);
    } catch (e) {
      setLive(null);
      onLive?.('');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      cleanup();
    }
  };

  return (
    <div className="hold-talk">
      <button
        className={`btn hold-talk-btn${compact ? ' mic-btn' : ''}${live ? ' hold-talk-on' : ''}`}
        aria-label={compact ? label : undefined}
        disabled={disabled}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          down();
        }}
        onPointerUp={() => void up()}
        onPointerCancel={() => void up()}
        onContextMenu={(e) => e.preventDefault()}
      >
        🎤{compact ? '' : ` ${live ? live.text || (live.ready ? 'Listening… release to send' : 'Starting the mic…') : label}`}
      </button>
      {error && <p className="small error-text">{error}</p>}
    </div>
  );
}
