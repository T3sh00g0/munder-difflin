'use strict';
/**
 * Agent-provider registry tests. Self-contained, no test framework — run with
 * `node test/agent-provider.test.cjs` (mirrors test/kg-core.test.cjs). The
 * registry lives in TypeScript (src/shared/agentProvider.ts), so we transpile it
 * and its two dependency-free command-group siblings with the bundled `typescript`
 * compiler into a temp dir and require the result. Exercises the copilot preset
 * (GitHub Copilot CLI) end to end: registration, command inference, the print-mode
 * flag shape, and the model/resume passthrough — alongside the pre-existing codex
 * preset as a guard against regressions.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SHARED = path.join(__dirname, '..', 'src', 'shared');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprov-'));
for (const name of ['claudeCommands', 'codexCommands', 'grokCommands', 'agentProvider']) {
  const src = fs.readFileSync(path.join(SHARED, `${name}.ts`), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js, 'utf8');
}
const ap = require(path.join(out, 'agentProvider.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
}

console.log('agent-provider registry tests');

test('copilot is a recognized, selectable provider', () => {
  assert.ok(ap.isAgentProvider('copilot'), 'isAgentProvider("copilot")');
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'copilot'), 'preset registered');
});

test('inferAgentProvider maps the copilot binary (with path/flags) to copilot', () => {
  assert.strictEqual(ap.inferAgentProvider('copilot'), 'copilot');
  assert.strictEqual(ap.inferAgentProvider('/usr/local/bin/copilot --model gpt-5.4'), 'copilot');
});

test('copilot preset builds the documented non-interactive print-mode shape', () => {
  const p = ap.providerPreset('copilot');
  assert.strictEqual(p.defaultCommand, 'copilot', 'default command binary');
  assert.strictEqual(p.initialPromptFlag, '-p', 'prompt rides in via -p');
  assert.strictEqual(ap.autoModeFlagForProvider('copilot'), '-s --allow-all-tools --no-ask-user');
  assert.strictEqual(p.autoFlag, '-s --allow-all-tools --no-ask-user', 'autoFlag mirrors autoModeFlag');
});

test('copilot passes model + resume through, non-hiveAware, never auto-receives inbox', () => {
  const p = ap.providerPreset('copilot');
  assert.ok(p.supportsModel && p.modelFlag === '--model', 'model picker + --model');
  assert.strictEqual(p.resumeFlag, '--resume', 'session resume flag');
  assert.strictEqual(p.hiveAware, false, 'no Claude-only identity injection');
  assert.strictEqual(ap.canReceiveInbox('copilot'), false, 'print mode exits, no drain → bounces');
  assert.strictEqual(ap.bridgeOf('copilot'), undefined, 'no hook/proxy bridge');
});

test('cursor is a recognized, selectable, god-eligible provider', () => {
  assert.ok(ap.isAgentProvider('cursor'), 'isAgentProvider("cursor")');
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'cursor'), 'preset registered');
  assert.strictEqual(ap.canReceiveInbox('cursor'), true, 'interactive TUI can receive inbox');
});

test('inferAgentProvider maps cursor-agent (canonical) and agent (alias) to cursor', () => {
  assert.strictEqual(ap.inferAgentProvider('cursor-agent'), 'cursor');
  assert.strictEqual(ap.inferAgentProvider('/Users/me/.local/bin/cursor-agent --model gpt-5.6-luna-high'), 'cursor');
  assert.strictEqual(ap.inferAgentProvider('agent'), 'cursor');
});

test('cursor preset is interactive (no -p), uses force+trust auto flags, types seed into TUI', () => {
  const p = ap.providerPreset('cursor');
  assert.strictEqual(p.defaultCommand, 'cursor-agent', 'default command binary');
  assert.strictEqual(p.initialPromptFlag, undefined, 'no -p; stay interactive');
  assert.strictEqual(p.seedDelivery, 'type-into-tui', 'hive protocol typed after boot');
  assert.strictEqual(ap.autoModeFlagForProvider('cursor'), '--force --trust');
  assert.strictEqual(p.autoFlag, '--force --trust', 'autoFlag mirrors autoModeFlag');
  assert.strictEqual(p.recommendedOrchestratorModel, 'gpt-5.6-luna-high');
  assert.ok(p.supportsModel && p.modelFlag === '--model', 'model picker + --model');
  assert.strictEqual(p.resumeFlag, '--resume', 'session resume flag');
  assert.strictEqual(p.hiveAware, false, 'no Claude-only identity injection');
  assert.strictEqual(ap.bridgeOf('cursor'), undefined, 'no hook/proxy bridge yet');
});

test('codex preset still resolves (no regression)', () => {
  assert.strictEqual(ap.inferAgentProvider('codex'), 'codex');
  assert.strictEqual(ap.providerPreset('codex').defaultCommand, 'codex');
});

// ── takeTopLevelModelFlag (TSF-16 mode b) ────────────────────────────────────
// The packaged OpenCode desktop V2 CLI rejects a top-level --model outright
// ("Unrecognized flag: --model", crash 2026-10-22T10:18Z), so spawnAgentCore
// lifts the value off argv and re-routes it into the config injection. These
// pin the pure helper that does the lifting.

test('takeTopLevelModelFlag strips --model and its value from argv', () => {
  const r = ap.takeTopLevelModelFlag(['opencode', '--model', 'anthropic/claude-sonnet-4-5']);
  assert.deepStrictEqual(r.args, ['opencode']);
  assert.strictEqual(r.model, 'anthropic/claude-sonnet-4-5');
});

test('takeTopLevelModelFlag strips the flag wherever it sits', () => {
  const r = ap.takeTopLevelModelFlag(['--prompt', 'hi', '--model', 'openai/gpt-5.6']);
  assert.deepStrictEqual(r.args, ['--prompt', 'hi']);
  assert.strictEqual(r.model, 'openai/gpt-5.6');
});

test('takeTopLevelModelFlag is a no-op when the flag is absent', () => {
  const r = ap.takeTopLevelModelFlag(['opencode', '--prompt', 'x']);
  assert.deepStrictEqual(r.args, ['opencode', '--prompt', 'x']);
  assert.strictEqual(r.model, '');
});

test('takeTopLevelModelFlag drops a stray valueless --model', () => {
  // A dangling flag must never reach the CLI: exactly that shape is what the
  // desktop CLI treats as fatal.
  const r = ap.takeTopLevelModelFlag(['opencode', '--model']);
  assert.deepStrictEqual(r.args, ['opencode']);
  assert.strictEqual(r.model, '');
});

test('takeTopLevelModelFlag keeps only the FIRST pair and consumes repeats fully', () => {
  // A repeat pair must not leave its value behind as an orphan positional —
  // the CLI could misread `c/d` as a prompt.
  const r = ap.takeTopLevelModelFlag(['--model', 'a/b', '--model', 'c/d']);
  assert.deepStrictEqual(r.args, []);
  assert.strictEqual(r.model, 'a/b');
});

test('takeTopLevelModelFlag honours a custom flag name by EXACT token only', () => {
  // Lifting `--model-verbose` must not eat `--model` (a different token) —
  // nor its value.
  const r = ap.takeTopLevelModelFlag(['--model-config', 'x', '--model-verbose', '--model', 'p/m'], '--model-verbose');
  assert.deepStrictEqual(r.args, ['--model-config', 'x', '--model', 'p/m']);
  assert.strictEqual(r.model, '');
});

test('takeTopLevelModelFlag never swallows a following flag as the value', () => {
  const r = ap.takeTopLevelModelFlag(['--model', '--prompt', 'hi']);
  assert.deepStrictEqual(r.args, ['--prompt', 'hi']);
  assert.strictEqual(r.model, '');
});

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll agent-provider tests passed');
