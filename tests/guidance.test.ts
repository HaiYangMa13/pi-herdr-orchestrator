import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GUIDANCE_SECTION, guidanceText, herdGuidance, herdToolsActive } from '../src/guidance.ts';

const live = { selectedTools: ['read', 'bash', 'herd_spawn', 'herd_status'] };

test('the contract is injected only when the orchestrator tools are live', () => {
  assert.equal(herdToolsActive(live), true);
  assert.ok(herdGuidance(live));
  assert.equal(herdGuidance({ selectedTools: ['read', 'bash'] }), undefined);
  assert.equal(herdGuidance({}), undefined);
});

test('a tool hidden behind another tool gets no contract', () => {
  assert.equal(herdToolsActive({ ...live, hiddenTools: ['herd_spawn'] }), false);
  assert.equal(herdGuidance({ ...live, hiddenTools: ['herd_spawn'] }), undefined);
});

test('the run root in the text is the one the extension actually uses', () => {
  const text = guidanceText('/tmp/herdr-root');
  assert.match(text, /\/tmp\/herdr-root\/runs\/<session>\/<label>\//);
});

test('the default run root honours PI_HERDR_ROOT', () => {
  const previous = process.env.PI_HERDR_ROOT;
  process.env.PI_HERDR_ROOT = '/tmp/env-root';
  try {
    assert.match(guidanceText(), /\/tmp\/env-root\/runs\//);
  } finally {
    if (previous === undefined) delete process.env.PI_HERDR_ROOT;
    else process.env.PI_HERDR_ROOT = previous;
  }
});

test('every tool the extension registers is documented, so the text cannot drift', async () => {
  const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  const registered = [...source.matchAll(/name:\s*"(herd_[a-z_]+)"/g)].map((match) => match[1]);
  assert.ok(registered.length >= 6, `expected the orchestrator tools, found ${registered.join(',')}`);
  const text = guidanceText('/tmp/root');
  for (const name of new Set(registered)) {
    assert.ok(text.includes(name), `guidance is missing registered tool ${name}`);
  }
});

test('no pinned model is hardcoded: the roster prints it at runtime', () => {
  const text = guidanceText('/tmp/root');
  assert.doesNotMatch(text, /local-cpa\/|\bgpt-|deepseek-/);
});

test('the registered hook replaces only its own section and removes stale guidance', async () => {
  const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  const match = source.match(/pi\.on\("before_agent_start", \(event\) => \{([\s\S]*?)\n\t\}\);/);
  assert.ok(match, 'expected the actual registered prompt hook');
  const hook = new Function('event', 'herdGuidance', 'GUIDANCE_SECTION', match[1]);
  const sections: Record<string, string> = { unrelated: 'keep me' };
  const options = { selectedTools: ['herd_spawn'], hiddenTools: [] as string[], sections };
  const invoke = () => hook({ systemPromptOptions: options }, herdGuidance, GUIDANCE_SECTION);
  invoke();
  assert.equal(sections[GUIDANCE_SECTION], guidanceText());
  invoke();
  assert.equal(sections[GUIDANCE_SECTION], guidanceText(), 'no duplicate append');
  options.selectedTools = [];
  invoke();
  assert.equal(sections[GUIDANCE_SECTION], undefined);
  assert.equal(sections.unrelated, 'keep me');
  options.selectedTools = ['herd_spawn'];
  invoke();
  options.hiddenTools = ['herd_spawn'];
  invoke();
  assert.deepEqual(sections, { unrelated: 'keep me' });
});

test('the contract says when to delegate proactively, not only how', () => {
  const text = guidanceText('/tmp/root');
  assert.match(text, /默认主动派活/);
  assert.match(text, /并行/);
  assert.match(text, /不派的四种/);
});

test('the section name satisfies the prompt builder naming rule', () => {
  assert.match(GUIDANCE_SECTION, /^[a-z][a-z0-9_-]*$/);
  assert.notEqual(GUIDANCE_SECTION, 'preamble');
});
