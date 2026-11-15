import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Step } from './investigate.ts';

(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';
(globalThis as Record<string, unknown>).window = { innerWidth: 960, innerHeight: 540, devicePixelRatio: 2 };
const { DiagnosisSession } = await import('./investigate.ts');

function recorder() {
  const steps: Step[] = [];
  return {
    steps,
    ui: {
      step: (s: Step, i?: number) => {
        if (i === undefined) {
          steps.push(s);
          return steps.length - 1;
        }
        steps[i] = s;
        return i;
      },
      ask: async () => 'Done',
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
test('session streams text, runs tools, sends results together, and the conversation continues', async () => {
  const calls: any[] = [];
  const script: any[] = [
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'Checking the default assistant.' },
        { type: 'tool_use', id: 't1', name: 'get_setting', input: { table: 'secure', key: 'assistant' } },
        { type: 'tool_use', id: 't2', name: 'run_command', input: { command: 'getprop ro.build.version.release' } },
      ],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'What I found: …' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure, here is more.' }] },
  ];
  const { steps, ui } = recorder();
  const session = new DiagnosisSession({ apiKey: 'x' }, ui, {
    send: async (p: any, onText: (s: string) => void) => {
      calls.push(structuredClone(p));
      const next = script.shift();
      for (const b of next.content) if (b.type === 'text') onText(b.text);
      return next;
    },
    runTool: async (name: string, input: any) => ({ ran: name, input }),
  });
  await session.say('voice is broken');
  // Second request: assistant turn kept as returned, then both tool results in one user message.
  const second = calls[1].messages;
  assert.equal(second[1].content[0].type, 'thinking');
  assert.deepEqual(second[2].content.map((c: any) => c.tool_use_id), ['t1', 't2']);
  assert.deepEqual(steps.map((s) => s.kind), ['user', 'thought', 'tool', 'tool', 'final']);
  // Follow-up after the answer continues the same conversation.
  await session.say('tell me more');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].messages.length, 5);
  assert.equal(steps[steps.length - 1].kind, 'final');
});

test('a message sent while Claude works is passed in with the next tool results', async () => {
  const calls: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const script: any[] = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'device_report', input: {} }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  ];
  const { steps, ui } = recorder();
  const session = new DiagnosisSession({ apiKey: 'x' }, ui, {
    send: async (p: any) => {
      calls.push(structuredClone(p));
      return script.shift();
    },
    runTool: async () => {
      await gate;
      return { ok: true };
    },
  });
  const run = session.say('start');
  await new Promise((r) => setTimeout(r, 10));
  await session.say('also try German');
  release();
  await run;
  const lastUser = calls[1].messages[2].content;
  assert.equal(lastUser[0].type, 'tool_result');
  assert.ok(lastUser[1].text.includes('also try German'));
  assert.ok(steps.some((s) => s.kind === 'user' && s.queued));
});

test('after Stop, open tool calls are closed so the conversation can continue', async () => {
  const calls: any[] = [];
  const { ui } = recorder();
  let session!: InstanceType<typeof DiagnosisSession>;
  const script: any[] = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'device_report', input: {} }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
  ];
  session = new DiagnosisSession({ apiKey: 'x' }, ui, {
    send: async (p: any) => {
      calls.push(structuredClone(p));
      return script.shift();
    },
    runTool: async () => {
      session.stop();
      return { ok: true };
    },
  });
  await session.say('start');
  await session.say('carry on');
  const msgs = calls[1].messages;
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(last.content.some((c: any) => c.type === 'tool_result' && c.tool_use_id === 't1'));
  assert.ok(last.content.some((c: any) => c.type === 'text' && c.text === 'carry on'));
});

test('a check that never answers times out, and Claude is told so', async () => {
  const calls: any[] = [];
  const script: any[] = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'system_voice_test', input: { language: 'en-US', speak_text: 'hi', delay_ms: 1000 } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The voice screen never answered.' }] },
  ];
  const { ui } = recorder();
  const session = new DiagnosisSession({ apiKey: 'x' }, ui, {
    send: async (p: any) => {
      calls.push(structuredClone(p));
      return script.shift();
    },
    runTool: () => new Promise(() => {}), // hangs forever, like the TV's voice screen
    limits: { system_voice_test: 50 },
  });
  await session.say('start');
  const result = calls[1].messages[2].content[0];
  assert.equal(result.tool_use_id, 't1');
  assert.ok(String(result.content).includes('timedOut'));
});

test('Stop ends a check that is still waiting', async () => {
  const { steps, ui } = recorder();
  let session!: InstanceType<typeof DiagnosisSession>;
  session = new DiagnosisSession({ apiKey: 'x' }, ui, {
    send: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'run_command', input: { command: 'getprop' } }] }) as any,
    runTool: () => new Promise(() => {}),
    limits: { run_command: 0 },
  });
  const run = session.say('start');
  await new Promise((r) => setTimeout(r, 20));
  session.stop();
  await run;
  assert.equal(steps[steps.length - 1].kind, 'error');
});
