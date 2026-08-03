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
  readFileSync,
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
  UserPromptQueued: 'running',
  TurnStarted: 'running',
  PostToolUse: 'running',
  PostToolUseFailure: 'failed',
  PermissionRequest: 'waiting',
  PermissionResult: 'running',
  Stop: 'review',
  StopFailure: 'failed',
  Interrupt: 'idle',
  SubagentStart: 'running',
  SubagentStop: 'running',
  TaskStarted: 'running',
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

function readSessionRecord(sessionFile) {
  try {
    return JSON.parse(readFileSync(sessionFile, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeSessionRecord(sessionFile, record) {
  // Write tmp + rename so the daemon never reads a half-written file.
  const tmpFile = `${sessionFile}.${process.pid}.tmp`;
  writeFileSync(tmpFile, `${JSON.stringify(record)}\n`);
  renameSync(tmpFile, sessionFile);
}

function titleOrBasename(payload) {
  if (typeof payload?.session_title === 'string' && payload.session_title.trim().length > 0) {
    return payload.session_title.trim();
  }
  if (typeof payload?.cwd === 'string' && payload.cwd.length > 0) {
    return path.basename(payload.cwd);
  }
  return undefined;
}

/**
 * Heartbeats prove the session is alive without changing what it is doing:
 * the record's `state` and `ts` (state age, drives the daemon's decay) are
 * preserved — only the file mtime (liveness, drives stale pruning) and
 * `last_heartbeat` move. A heartbeat for a session we never saw before
 * creates an idle record so the pet still shows it.
 */
function refreshLiveness(sessionFile, sessionsDir, payload) {
  mkdirSync(sessionsDir, { recursive: true });
  const prev = readSessionRecord(sessionFile);
  const title =
    typeof payload?.session_title === 'string' && payload.session_title.trim().length > 0
      ? payload.session_title.trim()
      : undefined;
  writeSessionRecord(sessionFile, {
    session_id: payload.session_id ?? '',
    state: typeof prev?.state === 'string' ? prev.state : 'idle',
    event: typeof prev?.event === 'string' ? prev.event : 'SessionHeartbeat',
    tool_name: prev?.tool_name,
    text: prev?.text,
    // A fresh title wins, then the label we already had, then the dirname.
    project: title ?? prev?.project ?? titleOrBasename(payload),
    client_type: payload.client_type ?? prev?.client_type,
    model: prev?.model,
    profile: prev?.profile,
    ts: typeof prev?.ts === 'number' ? prev.ts : Date.now() / 1000,
    last_heartbeat: Date.now() / 1000,
  });
  pruneStaleSessions(sessionsDir);
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

    if (event === 'SessionHeartbeat') {
      refreshLiveness(sessionFile, sessionsDir, payload);
      return;
    }

    const state = STATE_BY_EVENT[event];
    if (state === undefined) return;

    mkdirSync(sessionsDir, { recursive: true });

    // Text carried alongside the state for the daemon's speech bubble. New
    // events that don't bring their own text inherit the previous one, so a
    // turn's prompt survives into Stop/PostToolUse states.
    let text;
    if (event === 'PermissionRequest') {
      // display.summary is the same one-liner the approval dialog shows
      // (e.g. the command or file being approved); action is the fallback.
      const summary = payload?.display?.summary;
      if (typeof summary === 'string' && summary.trim().length > 0) {
        text = summary.replace(/\s+/g, ' ').trim().slice(0, 120);
      } else if (typeof payload.action === 'string' && payload.action.trim().length > 0) {
        text = payload.action.replace(/\s+/g, ' ').trim().slice(0, 120);
      }
    } else if (event === 'Notification') {
      const title = typeof payload.title === 'string' ? payload.title.trim() : '';
      const body = typeof payload.body === 'string' ? payload.body.trim() : '';
      const combined = [title, body].filter(Boolean).join('：');
      if (combined.length > 0) text = combined.replace(/\s+/g, ' ').slice(0, 120);
    } else if (typeof payload.prompt === 'string' && payload.prompt.trim().length > 0) {
      text = payload.prompt.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    // The session title beats the directory name: it is the only label that
    // tells same-directory sessions apart.
    const project = titleOrBasename(payload);
    const prev = readSessionRecord(sessionFile);
    text ??= typeof prev?.text === 'string' ? prev.text : undefined;
    const finalProject = project ?? (typeof prev?.project === 'string' ? prev.project : undefined);

    const record = {
      session_id: payload.session_id ?? '',
      state,
      event,
      tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
      text,
      project: finalProject,
      client_type: payload.client_type ?? prev?.client_type,
      model: payload.model ?? prev?.model,
      profile: payload.profile ?? prev?.profile,
      ts: Date.now() / 1000,
    };
    writeSessionRecord(sessionFile, record);
    pruneStaleSessions(sessionsDir);
  });
}

try {
  await main();
} catch {
  // Hooks must never break the agent loop.
}
