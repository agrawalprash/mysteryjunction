// Read the focused card's "why this" line aloud, for profiles with read-aloud on.
// Waits a moment so moving quickly across cards doesn't start a dozen sentences.

import { activeProfile } from './profiles.ts';
import { sayAloud } from './voice.ts';

let timer: ReturnType<typeof setTimeout> | undefined;
let last = '';

export function readFocused(text: string | undefined) {
  clearTimeout(timer);
  if (!text || !activeProfile().options.readAloud) return;
  timer = setTimeout(() => {
    if (text === last) return;
    last = text;
    sayAloud(text);
  }, 700);
}

/** Stop reading (e.g. when a video starts). */
export function stopReading() {
  clearTimeout(timer);
  last = '';
  sayAloud('');
}
