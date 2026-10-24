'use strict';

/**
 * An agent killed by its provider crashing used to leave NO durable cause.
 *
 * Observed live on 2026-08-24: a `claude` CLI panicked 923 ms into startup
 * (Bun, SIGILL) and the hive recorded exactly
 *   {"kind":"archive","agentId":"god","archived":true}
 * — no exit code, no signal, no output. The crash banner existed only in a UI
 * terminal pane. A two-second death and a completed agent were indistinguishable
 * in the only record the hive keeps.
 *
 * `recordAgentExit` fixes that. These tests pin the three properties that make
 * it useful and safe:
 *   1. a signal-death is recorded even though its exit code is 0;
 *   2. a CLEAN exit records nothing (a diagnostic, not an audit log);
 *   3. the raw output goes to a GITIGNORED file, never into log.jsonl —
 *      the hive repo is committed on every change, so a token captured from
 *      provider output would otherwise be permanent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, redactSecrets } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-exit-'));
}

function readLog(home) {
  const p = path.join(home, 'hive', 'log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function freshHive(t) {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  return { home, hive };
}

test('a signal death is recorded even though its exit code is 0', async (t) => {
  const { home, hive } = await freshHive(t);

  // SIGILL is exactly the shape that bit us: node-pty reports exitCode 0 and a
  // non-zero signal, so an exitCode-only check calls this a clean finish.
  hive.recordAgentExit('a1', { exitCode: 0, signal: 4, tail: 'panic: Illegal instruction\n' });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1, 'a signal death must be recorded');
  assert.equal(rows[0].agentId, 'a1');
  assert.equal(rows[0].signal, 4);
  assert.equal(rows[0].exitCode, 0);
  assert.equal(rows[0].abnormal, true);
});

test('a non-zero exit code is recorded', async (t) => {
  const { home, hive } = await freshHive(t);
  hive.recordAgentExit('a1', { exitCode: 127, tail: 'claude: command not found\n' });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exitCode, 127);
  assert.equal(rows[0].signal, null);
});

test('a CLEAN exit records nothing — this is a diagnostic, not an audit log', async (t) => {
  const { home, hive } = await freshHive(t);

  hive.recordAgentExit('a1', { exitCode: 0, signal: 0, tail: 'goodbye\n' });
  hive.recordAgentExit('a1', { exitCode: 0, tail: 'goodbye\n' });
  hive.recordAgentExit('a1', {});

  assert.equal(readLog(home).filter((r) => r.kind === 'agent-exit').length, 0);
});

test('raw output goes to a gitignored crashes/ file, NOT into log.jsonl', async (t) => {
  const { home, hive } = await freshHive(t);

  // A plausible secret in provider output. It must reach the dump file and must
  // NOT reach log.jsonl, which the hive commits.
  const secret = 'sk-ant-EXAMPLE-NOT-A-REAL-KEY-000';
  hive.recordAgentExit('a1', { exitCode: 0, signal: 11, tail: `boom ${secret}\n`, command: '/usr/bin/claude --model x' });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1);

  const raw = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8');
  assert.ok(!raw.includes(secret), 'log.jsonl must never carry raw provider output');

  const tailPath = rows[0].tailPath;
  assert.ok(tailPath, 'the row must point at the dump');
  const dump = fs.readFileSync(tailPath, 'utf8');
  assert.ok(dump.includes(secret), 'the dump keeps the output that explains the death');
  assert.ok(dump.includes('signal:   11'), 'the dump carries a header naming the signal');
  assert.ok(dump.includes('/usr/bin/claude --model x'), 'and the command that died');

  // The dump must live under crashes/, which ensureHive gitignores.
  assert.equal(path.basename(path.dirname(tailPath)), 'crashes');
  const ignore = fs.readFileSync(path.join(home, 'hive', '.gitignore'), 'utf8');
  assert.ok(ignore.split('\n').includes('crashes/'), 'crashes/ must be gitignored');
});

test('a death is still recorded when there is no output to dump', async (t) => {
  const { home, hive } = await freshHive(t);
  hive.recordAgentExit('a1', { exitCode: 0, signal: 9, tail: '' });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1, 'losing the output must not lose the fact of the death');
  assert.equal(rows[0].signal, 9);
  assert.equal(rows[0].tailPath, null);
});

// ── redacted spawn command line (TSF-16 observability) ──────────────────────
// PTY exits now carry the FULL command line AS EXECUTED so a spawn failure is
// diagnosable in one step (crashes 10-20→10-22 carried only the resolved exe,
// and "Linha de comando muito longa" had to be inferred). The line may contain
// engine tokens, so it is redacted BEFORE any disk write — THROUGH the hive's
// house redactSecrets (same battery that guards messages), by design: one
// choke point, one tested mask. The disabled dump keeps the readable
// diagnostic; log.jsonl (committed) keeps only the masked line.

test('redactSecrets masks credentials but keeps the line readable', () => {
  const line = 'opencode run --model anthropic/claude-sonnet-4-5 --api-key sk-ant-EXAMPLE-1234567890 -H "Authorization: Bearer eyJa.aaa.bbb"';
  const out = redactSecrets(line);
  assert.ok(out.includes('--model anthropic/claude-sonnet-4-5'), 'model slug survives');
  assert.ok(out.includes('--api-key'), 'the flag survives');
  assert.ok(!out.includes('sk-ant-EXAMPLE'), 'sk- tokens are masked');
  assert.ok(!out.includes('eyJa'), 'JWT/bearer values are masked');
  assert.ok(!/Bearer [A-Za-z0-9]/.test(out), 'bearer values are masked');
  assert.ok(out.includes('[redacted]'), 'the mask is named');
});

test('redactSecrets masks key=value params WITHOUT blanket-redacting entropy', () => {
  const line = 'cli --token=abcd1234efgh5678ijkl --randomarg AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const out = redactSecrets(line);
  assert.ok(out.includes('--token='), 'flag survives');
  assert.ok(!out.includes('abcd1234efgh'), 'token value is gone');
  // House policy (see redactSecrets doc): NO entropy-based masking — an unnamed
  // long blob may be a git SHA or a path segment, so it SURVIVES; only
  // credential-shaped values are dropped.
  assert.ok(out.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'unnamed blob survives');
});

test('redactSecrets leaves ordinary spawn lines byte-identical', () => {
  const line = 'C:\\Users\\r\\AppData\\Local\\Programs\\@opencodedesktop\\resources\\opencode-cli.exe --prompt "ola" --model p/m';
  assert.strictEqual(redactSecrets(line), line, 'no false positive on ordinary argv');
});

test('a token-bearing spawnCommand is redacted in BOTH dump and log.jsonl', async (t) => {
  const { home, hive } = await freshHive(t);
  const token = 'sk-ant-EXAMPLE-NOT-A-REAL-KEY-000';
  hive.recordAgentExit('a1', {
    exitCode: 1,
    tail: 'Linha de comando muito longa.\n',
    command: 'C:\\npm\\opencode.cmd',
    spawnCommand: `C:\\npm\\opencode.cmd --api-key ${token} --prompt "ola"`
  });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].spawnCommand, 'log.jsonl row carries the spawn line');
  assert.ok(!JSON.stringify(rows).includes(token), 'log.jsonl never carries the raw token');
  assert.ok(rows[0].spawnCommand.includes('[redacted]'), 'the value is masked in log.jsonl');
  assert.ok(rows[0].spawnCommand.includes('--api-key'), 'the flag is kept for triage');

  const dump = fs.readFileSync(rows[0].tailPath, 'utf8');
  assert.ok(dump.includes('spawnCmd: '), 'the dump header names the spawn line');
  assert.ok(!dump.includes(token), 'the dump masks the token too');
  assert.ok(dump.includes('--prompt'), 'the rest of the line survives for diagnosis');
});

test('a clean spawnCommand passes through unchanged', async (t) => {
  const { home, hive } = await freshHive(t);
  const line = 'C:\\npm\\opencode.cmd --prompt "ola"';
  hive.recordAgentExit('a1', { exitCode: 1, tail: 'boom\n', spawnCommand: line });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1);
  assert.strictEqual(rows[0].spawnCommand, line, 'no false redaction on ordinary argv');
  const dump = fs.readFileSync(rows[0].tailPath, 'utf8');
  assert.ok(dump.includes(line), 'the dump carries the verbatim line');
});

test('no spawnCommand → no spawnCmd field anywhere', async (t) => {
  const { home, hive } = await freshHive(t);
  hive.recordAgentExit('a1', { exitCode: 1, tail: 'boom\n', spawnCommand: undefined });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].spawnCommand, undefined, 'log.jsonl row omits the field');
  const dump = fs.readFileSync(rows[0].tailPath, 'utf8');
  assert.ok(!dump.includes('spawnCmd:'), 'dump header omits the row');
});
