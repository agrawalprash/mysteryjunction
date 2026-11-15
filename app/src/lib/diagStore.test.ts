import { test } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';
(globalThis as Record<string, unknown>).window = { innerWidth: 960, innerHeight: 540, devicePixelRatio: 2 };
const store = await import('./diagStore.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */
test('shared session: a question can be answered by a message (e.g. typed on the phone), outputs are trimmed for the link', async () => {
  const script: any[] = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'ask_user', input: { question: 'Hold the button?', options: ['Done'] } }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'run_command', input: { command: 'getprop' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Found it.' }] },
  ];
  store.startDiag({ apiKey: 'x' }, 'voice broken', {
    send: async () => script.shift(),
    runTool: async (name: string, input: any, ui: any) => (name === 'ask_user' ? { answer: await ui.ask(input.question, input.options) } : { big: 'x'.repeat(5000) }),
  });
  for (let i = 0; i < 50 && !store.diagSnapshot().pending; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.diagSnapshot().pending?.question, 'Hold the button?');
  store.sayDiag('Done, the light went red');
  for (let i = 0; i < 50 && store.diagSnapshot().busy; i++) await new Promise((r) => setTimeout(r, 5));
  const snap = store.diagSnapshot(true);
  assert.equal(snap.pending, null);
  assert.ok(snap.steps.some((s) => s.kind === 'user' && s.text === 'Done, the light went red'));
  const tool = snap.steps.find((s) => s.kind === 'tool' && s.name === 'run_command') as any;
  assert.ok(tool.output.length < 3200 && tool.output.endsWith('[trimmed]'));
  assert.equal(snap.steps[snap.steps.length - 1].kind, 'final');
});
