// The diagnosis session lives here (not in a screen), so it keeps running when you
// leave Settings, and so a linked phone can watch and drive it over the Wi-Fi link.

import { DiagnosisSession, diagnosisIntro, type SessionDeps, type Step } from './investigate.ts';
import type { ClaudeAuth } from './claude.ts';

export interface DiagSnapshot {
  active: boolean;
  busy: boolean;
  steps: Step[];
  pending: { question: string; options: string[] } | null;
}

let session: DiagnosisSession | null = null;
let steps: Step[] = [];
let pending: { question: string; options: string[]; resolve: (a: string) => void } | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

export function subscribeDiag(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const ui = {
  step(s: Step, index?: number) {
    if (index === undefined) steps = [...steps, s];
    else steps = steps.map((x, j) => (j === index ? s : x));
    emit();
    return index ?? steps.length - 1;
  },
  ask(question: string, options: string[]) {
    return new Promise<string>((resolve) => {
      pending = { question, options, resolve };
      emit();
    });
  },
};

function track(p: Promise<void>) {
  emit();
  p.finally(emit);
}

export function startDiag(auth: ClaudeAuth, symptoms: string, deps?: Partial<SessionDeps>) {
  stopDiag();
  steps = [];
  session = new DiagnosisSession(auth, ui, deps);
  track(session.say(diagnosisIntro(symptoms)));
}

/** A message from the owner: answers the open question if there is one, otherwise goes to Claude. */
export function sayDiag(text: string) {
  const t = text.trim();
  if (!t) return;
  if (pending) {
    const p = pending;
    pending = null;
    ui.step({ kind: 'user', text: t });
    p.resolve(t);
    return;
  }
  if (session) track(session.say(t));
}

export function stopDiag() {
  session?.stop();
  if (pending) {
    const p = pending;
    pending = null;
    p.resolve('The owner stopped the investigation.');
  }
  emit();
}

/** Current state; `compact` trims long outputs (for sending to the phone). */
export function diagSnapshot(compact = false): DiagSnapshot {
  return {
    active: !!session,
    busy: !!session?.busy,
    pending: pending ? { question: pending.question, options: pending.options } : null,
    steps: compact
      ? steps.map((s) => (s.kind === 'tool' && s.output && s.output.length > 3000 ? { ...s, output: `${s.output.slice(0, 3000)}\n…[trimmed]` } : s))
      : steps,
  };
}
