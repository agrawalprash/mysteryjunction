import { test } from 'node:test';
import assert from 'node:assert/strict';
(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';
(globalThis as Record<string, unknown>).window = { innerWidth: 960, innerHeight: 540, devicePixelRatio: 2 };
const { investigate } = await import('./investigate.ts');

test('investigation loops through tool calls, passes results back together, and ends with the final answer', async () => {
  const calls: any[] = [];
  const script: any[] = [
    { stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Checking the default assistant and the speech service.' },
      { type: 'tool_use', id: 't1', name: 'get_setting', input: { table: 'secure', key: 'assistant' } },
      { type: 'tool_use', id: 't2', name: 'run_command', input: { command: 'getprop ro.build.version.release' } },
    ] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'ask_user', input: { question: 'Hold the mic button?', options: ['Done'] } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'What I found: …' }] },
  ];
  const steps: any[] = [];
  const answer = await investigate(
    { apiKey: 'x' },
    'voice broken',
    { step: (s, i) => { if (i === undefined) { steps.push(s); return steps.length - 1; } steps[i] = s; return i; }, ask: async () => 'Done' },
    () => false,
    {
      create: async (p) => { calls.push(structuredClone(p)); return script.shift(); },
      runTool: async (name, input, ui) => (name === 'ask_user' ? { answer: await ui.ask(String(input.question), []) } : { ran: name, input }),
    },
  );
  assert.equal(answer, 'What I found: …');
  assert.equal(calls.length, 3);
  // Second request: assistant turn kept as-is (thinking block included), then both tool results in ONE user message.
  const second = calls[1].messages;
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[1].content[0].type, 'thinking');
  assert.equal(second[2].role, 'user');
  assert.deepEqual(second[2].content.map((c: any) => c.tool_use_id), ['t1', 't2']);
  assert.ok(calls.every((c) => c.tools.length > 0 && c.cache_control?.type === 'ephemeral'));
  // Steps shown on screen: thought, two tools (with outputs), one tool, final.
  assert.deepEqual(steps.map((s) => s.kind), ['thought', 'tool', 'tool', 'tool', 'final']);
  assert.ok(steps[1].output.includes('get_setting'));
});

test('stops asking for tools at the step limit', async () => {
  let n = 0;
  const seen: any[] = [];
  const answer = await investigate(
    { apiKey: 'x' },
    'x',
    { step: () => 0, ask: async () => '' },
    () => false,
    {
      create: async (p) => {
        seen.push(p);
        n++;
        if (p.tool_choice?.type === 'none') return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'final' }] } as any;
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${n}`, name: 'device_report', input: {} }] } as any;
      },
      runTool: async () => ({ ok: true }),
    },
  );
  assert.equal(answer, 'final');
  assert.equal(seen.filter((p) => p.tool_choice?.type === 'none').length, 1);
});
