#!/usr/bin/env node
/**
 * kimi-pet session hook.
 *
 * Reads one JSON hook payload from stdin (snake_case keys, always including
 * `hook_event_name`, `session_id`, `cwd` — see packages/agent-core
 * src/session/hooks), maps the event to a desktop-pet state, and writes a
 * small per-session state file that the pet daemon polls:
 *
 *   <kimi_home>/pets/run/sessions/<session_id>.json
 *
 * The hook is fire-and-forget: it never prints to stdout, never blocks the
 * agent loop (exit 0 on every path), and does nothing when the pet runtime
 * has never been set up (no pets/run directory and no daemon pid file).
 */
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const STALE_SESSION_MS = 30 * 60 * 1000;

const STATE_BY_EVENT = {
  SessionStart: 'idle',
  UserPromptSubmit: 'running',
  PostToolUse: 'running',
  PostToolUseFailure: 'failed',
  PermissionRequest: 'waiting',
  PermissionResult: 'running',
  Stop: 'review',
  StopFailure: 'failed',
  Interrupt: 'idle',
  SubagentStart: 'running',
  SubagentStop: 'running',
  Notification: 'review',
  PreCompact: 'running',
  PostCompact: 'running',
};

function petsRunDir() {
  const home = process.env.KIMI_CODE_HOME ?? path.join(homedir(), '.kimi-code');
  return path.join(home, 'pets', 'run');
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(''));
  });
}

function sanitizeSessionId(sessionId) {
  const cleaned = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/** Remove state files of sessions that died without a SessionEnd. */
function pruneStaleSessions(sessionsDir) {
  let entries;
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(sessionsDir, entry);
    try {
      if (now - statSync(file).mtimeMs > STALE_SESSION_MS) unlinkSync(file);
    } catch {
      // best effort only
    }
  }
}

function main() {
  return readStdin().then((raw) => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const event = payload?.hook_event_name;
    const runDir = petsRunDir();
    const sessionsDir = path.join(runDir, 'sessions');
    const sessionFile = path.join(sessionsDir, `${sanitizeSessionId(payload?.session_id)}.json`);

    if (event === 'SessionEnd') {
      rmSync(sessionFile, { force: true });
      return;
    }

    const state = STATE_BY_EVENT[event];
    if (state === undefined) return;

    mkdirSync(sessionsDir, { recursive: true });
    const record = {
      session_id: payload.session_id ?? '',
      state,
      event,
      tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
      ts: Date.now() / 1000,
    };
    // Write tmp + rename so the daemon never reads a half-written file.
    const tmpFile = `${sessionFile}.${process.pid}.tmp`;
    writeFileSync(tmpFile, `${JSON.stringify(record)}\n`);
    renameSync(tmpFile, sessionFile);
    pruneStaleSessions(sessionsDir);
  });
}

try {
  await main();
} catch {
  // Hooks must never break the agent loop.
}
