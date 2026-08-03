/**
 * Tests for hooks/pet-hook.mjs — run with `node --test hooks/`.
 *
 * The hook is a stdin/stdout script, so each test spawns it against a fresh
 * KIMI_CODE_HOME in a temp dir and inspects the session state files.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOOK = new URL('./pet-hook.mjs', import.meta.url).pathname;

function makeHome() {
  return mkdtempSync(path.join(tmpdir(), 'kimi-pet-hook-test-'));
}

function runHook(home, payload) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...process.env, KIMI_CODE_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `hook must exit 0: ${result.stderr}`);
  return result;
}

function sessionsDir(home) {
  return path.join(home, 'pets', 'run', 'sessions');
}

function readSession(home, sessionId) {
  return JSON.parse(readFileSync(path.join(sessionsDir(home), `${sessionId}.json`), 'utf8'));
}

test('maps events to states and carries prompt text + project', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 's1',
    cwd: '/Users/x/my-project',
    prompt: '  帮我\n修一下  lint  ',
  });
  const record = readSession(home, 's1');
  assert.equal(record.state, 'running');
  assert.equal(record.project, 'my-project');
  assert.equal(record.text, '帮我 修一下 lint');
});

test('later events without text inherit the previous text', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/p', prompt: 'do it' });
  runHook(home, { hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/p', tool_name: 'Bash' });
  const record = readSession(home, 's1');
  assert.equal(record.state, 'running');
  assert.equal(record.text, 'do it');

  runHook(home, { hook_event_name: 'Stop', session_id: 's1', cwd: '/p' });
  assert.equal(readSession(home, 's1').state, 'review');
  assert.equal(readSession(home, 's1').text, 'do it');
});

test('PermissionRequest prefers display.summary, falls back to action', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, {
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    cwd: '/p',
    tool_name: 'Bash',
    display: { kind: 'generic', summary: 'Run rm -rf ./dist' },
    action: 'Call Bash',
  });
  let record = readSession(home, 's1');
  assert.equal(record.state, 'waiting');
  assert.equal(record.text, 'Run rm -rf ./dist');

  runHook(home, {
    hook_event_name: 'PermissionRequest',
    session_id: 's2',
    cwd: '/p',
    tool_name: 'Write',
    action: 'Write file',
  });
  record = readSession(home, 's2');
  assert.equal(record.text, 'Write file');
});

test('Notification combines title and body', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, {
    hook_event_name: 'Notification',
    session_id: 's1',
    cwd: '/p',
    title: '后台任务完成',
    body: 'npm test 通过',
  });
  const record = readSession(home, 's1');
  assert.equal(record.state, 'review');
  assert.equal(record.text, '后台任务完成：npm test 通过');
});

test('SessionEnd removes the session file', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/p' });
  assert.ok(existsSync(path.join(sessionsDir(home), 's1.json')));
  runHook(home, { hook_event_name: 'SessionEnd', session_id: 's1', cwd: '/p' });
  assert.ok(!existsSync(path.join(sessionsDir(home), 's1.json')));
});

test('sanitizes weird session ids', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, { hook_event_name: 'SessionStart', session_id: 'a b/c\\d:e', cwd: '/p' });
  assert.ok(existsSync(path.join(sessionsDir(home), 'a_b_c_d_e.json')));
});

test('ignores unknown events and invalid json without failing', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, { hook_event_name: 'Bogus', session_id: 's1' });
  runHook(home, 'not json at all');
  assert.ok(!existsSync(sessionsDir(home)) || readdirSync(sessionsDir(home)).length === 0);
});

test('prunes session files of long-dead sessions on write', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, { hook_event_name: 'SessionStart', session_id: 'stale', cwd: '/p' });
  const staleFile = path.join(sessionsDir(home), 'stale.json');
  const hourAgo = new Date(Date.now() - 3600_000);
  utimesSync(staleFile, hourAgo, hourAgo);

  runHook(home, { hook_event_name: 'SessionStart', session_id: 'fresh', cwd: '/p' });
  assert.ok(!existsSync(staleFile));
  assert.ok(existsSync(path.join(sessionsDir(home), 'fresh.json')));
});

test('maps the new lifecycle events to running', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  for (const [event, extra] of [
    ['TurnStarted', { turn_id: 0, origin_kind: 'user', prompt: 'go' }],
    ['UserPromptQueued', { prompt_id: 'p1', prompt: 'later', queue_length: 2 }],
    ['TaskStarted', { task_id: 't1', kind: 'process', description: 'npm test' }],
  ]) {
    runHook(home, { hook_event_name: event, session_id: `s-${event}`, cwd: '/p', ...extra });
    assert.equal(readSession(home, `s-${event}`).state, 'running', event);
  }
});

test('prefers session_title over the directory name for project', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 's1',
    cwd: '/Users/x/my-project',
    session_title: '修复登录页',
    client_type: 'kimi_code_cli',
    prompt: 'hi',
  });
  const record = readSession(home, 's1');
  assert.equal(record.project, '修复登录页');
  assert.equal(record.client_type, 'kimi_code_cli');

  // No title → directory name still wins.
  runHook(home, { hook_event_name: 'UserPromptSubmit', session_id: 's2', cwd: '/Users/x/other', prompt: 'hi' });
  assert.equal(readSession(home, 's2').project, 'other');
});

test('model and profile from SessionStart survive into later records', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, {
    hook_event_name: 'SessionStart',
    session_id: 's1',
    cwd: '/p',
    source: 'startup',
    model: 'kimi-k2',
    profile: 'agent',
  });
  assert.equal(readSession(home, 's1').model, 'kimi-k2');

  runHook(home, { hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/p', tool_name: 'Read' });
  const record = readSession(home, 's1');
  assert.equal(record.model, 'kimi-k2');
  assert.equal(record.profile, 'agent');
});

test('SessionHeartbeat refreshes liveness without touching state or ts', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, {
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    cwd: '/p',
    session_title: '长任务',
    action: 'Call Bash',
  });
  const before = readSession(home, 's1');
  const file = path.join(sessionsDir(home), 's1.json');
  const dayAgo = new Date(Date.now() - 86_400_000);
  utimesSync(file, dayAgo, dayAgo);

  runHook(home, { hook_event_name: 'SessionHeartbeat', session_id: 's1', cwd: '/p', uptime_ms: 60_000 });
  const after = readSession(home, 's1');
  assert.equal(after.state, 'waiting');
  assert.equal(after.ts, before.ts);
  assert.equal(after.project, '长任务');
  assert.equal(typeof after.last_heartbeat, 'number');
  // mtime is fresh again, so the daemon's stale check keeps the session.
  assert.ok(Date.now() - statSync(file).mtimeMs < 5000);
});

test('SessionHeartbeat alone creates an idle record', (t) => {
  const home = makeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  runHook(home, {
    hook_event_name: 'SessionHeartbeat',
    session_id: 's1',
    cwd: '/p/proj',
    session_title: '某会话',
    uptime_ms: 60_000,
  });
  const record = readSession(home, 's1');
  assert.equal(record.state, 'idle');
  assert.equal(record.project, '某会话');
});
