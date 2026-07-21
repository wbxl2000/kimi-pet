#!/usr/bin/env node
/**
 * petctl — control the kimi-pet desktop pet daemon and manage codex-compatible
 * pets. Cross-platform (macOS / Linux / Windows), zero dependencies.
 *
 * Pets live in <kimi_home>/pets/<pet-id>/{pet.json,spritesheet.webp} (the same
 * layout Codex uses, so ~/.codex/pets is picked up as a read-only fallback).
 * Runtime state lives in <kimi_home>/pets/run/ and is polled by the daemon:
 *   current.json           {"id": ..., "dir": ...}   the active pet
 *   control.json           {"cmd": "quit"|"reload"}  one-shot commands
 *   sessions/<sid>.json    per-session hook states   (written by hooks/pet-hook.mjs)
 *   position.json          {"x": ..., "y": ...}      dragged-to window spot
 *   daemon.pid / daemon.log
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_PY = path.join(SCRIPT_DIR, '..', 'daemon', 'pet_daemon.py');
const REQUIREMENTS_TXT = path.join(SCRIPT_DIR, '..', 'daemon', 'requirements.txt');

const KIMI_HOME = process.env.KIMI_CODE_HOME ?? path.join(homedir(), '.kimi-code');
const PET_HOME = path.join(KIMI_HOME, 'pets');
const RUN_DIR = path.join(PET_HOME, 'run');
const SESSIONS_DIR = path.join(RUN_DIR, 'sessions');
const CURRENT_JSON = path.join(RUN_DIR, 'current.json');
const CONTROL_JSON = path.join(RUN_DIR, 'control.json');
const PID_FILE = path.join(RUN_DIR, 'daemon.pid');
const LOG_FILE = path.join(RUN_DIR, 'daemon.log');
const VENV_DIR = path.join(PET_HOME, 'venv');
const CODEX_PETS = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, 'pets')
  : path.join(homedir(), '.codex', 'pets');
const GALLERY_RAW =
  process.env.KIMI_PET_GALLERY_RAW ??
  'https://raw.githubusercontent.com/legeling/awesome-codex-pet/main';
const GITHUB_REPO = 'wbxl2000/kimi-pet';
const WIN = process.platform === 'win32';
const VENV_PYTHON = path.join(VENV_DIR, WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python');
const DAEMON_BIN_DIR = path.join(PET_HOME, 'bin');
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*--[a-z0-9]+(-[a-z0-9]+)*$/;

const log = (msg) => console.log(`petctl: ${msg}`);
const die = (msg) => {
  console.error(`petctl: ${msg}`);
  process.exit(1);
};

const USAGE = `Usage: petctl <command> [args]

Daemon:
  summon [pet-id]     Start the desktop pet (optionally switching to pet-id first).
                      Uses the plugin venv if present, otherwise downloads the
                      prebuilt daemon binary (python3 not needed), with the
                      venv as fallback.
  dismiss             Stop the desktop pet daemon.
  status              Show daemon state, active pet, and live session states.
  update-daemon       Re-download the prebuilt daemon binary (when using it).

Pets (codex-compatible: pet.json + spritesheet.webp):
  list                List installed pets (kimi home + ~/.codex/pets fallback).
  gallery             List pets available in the awesome-codex-pet gallery.
  install <id|dir>    Install a pet from the gallery by slug (e.g. doro--lingxiaotian)
                      or copy a local directory containing pet.json + spritesheet.
  use <pet-id>        Select the active pet (restarts the daemon's sprite if running).
  home                Print the directories petctl uses.
`;

function ensureRunDir() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, file);
}

function daemonPid() {
  try {
    const pid = Number.parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function daemonAlive() {
  const pid = daemonPid();
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every installed pet as [{id, dir}], kimi home first, codex second. */
function eachPet() {
  const out = [];
  for (const root of [PET_HOME, CODEX_PETS]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      if (existsSync(path.join(dir, 'pet.json'))) out.push({ id: entry.name, dir });
    }
  }
  return out;
}

function findPetDir(id) {
  return eachPet().find((pet) => pet.id === id)?.dir;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.error) die(`${cmd} failed: ${result.error.message}`);
  if (result.status !== 0) die(`${cmd} ${args.join(' ')} exited with ${result.status}`);
}

// -- prebuilt daemon binary -----------------------------------------------

function daemonAssetName() {
  const names = {
    'darwin arm64': 'kimi-pet-daemon-macos-arm64',
    'darwin x64': 'kimi-pet-daemon-macos-x64',
    'linux x64': 'kimi-pet-daemon-linux-x64',
    'win32 x64': 'kimi-pet-daemon-windows-x64.exe',
  };
  return names[`${process.platform} ${process.arch}`];
}

function daemonBinaryPath() {
  const asset = daemonAssetName();
  return asset === undefined ? undefined : path.join(DAEMON_BIN_DIR, asset);
}

async function downloadDaemonBinary() {
  const asset = daemonAssetName();
  const bin = daemonBinaryPath();
  if (asset === undefined || bin === undefined) return undefined;
  const url = `https://github.com/${GITHUB_REPO}/releases/latest/download/${asset}`;
  log(`downloading prebuilt daemon (${asset}) ...`);
  let resp;
  try {
    resp = await fetch(url, { redirect: 'follow' });
  } catch {
    resp = undefined;
  }
  if (resp === undefined || !resp.ok) {
    log(`download failed (HTTP ${resp?.status ?? 'network error'}); falling back to python venv`);
    return undefined;
  }
  mkdirSync(DAEMON_BIN_DIR, { recursive: true });
  writeFileSync(bin, Buffer.from(await resp.arrayBuffer()));
  spawnSync('chmod', ['+x', bin]);
  if (process.platform === 'darwin') {
    // curl-downloaded binaries are quarantined by Gatekeeper; un-quarantine.
    spawnSync('xattr', ['-d', 'com.apple.quarantine', bin]);
  }
  return bin;
}

/**
 * How to launch the daemon, in preference order:
 * 1. the plugin's own daemon .py via the venv (always the freshest code —
 *    the plugin dir is replaced on every plugin update);
 * 2. an already-downloaded prebuilt binary;
 * 3. undefined → caller should download or create the venv.
 */
function daemonCommand() {
  if (existsSync(VENV_PYTHON) && existsSync(DAEMON_PY)) {
    return { cmd: VENV_PYTHON, args: [DAEMON_PY] };
  }
  const bin = daemonBinaryPath();
  if (bin !== undefined && existsSync(bin)) return { cmd: bin, args: [] };
  return undefined;
}

function ensureDaemonEnv() {
  if (existsSync(VENV_PYTHON)) return;
  const python = WIN ? 'python' : 'python3';
  log(`creating python venv at ${VENV_DIR} ...`);
  run(python, ['-m', 'venv', VENV_DIR]);
  log('installing PySide6 (one-time, downloads ~100MB) ...');
  run(VENV_PYTHON, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
  run(VENV_PYTHON, ['-m', 'pip', 'install', '--quiet', '-r', REQUIREMENTS_TXT]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmdSummon(petId) {
  if (petId) cmdUse(petId);
  if (!existsSync(CURRENT_JSON)) {
    const first = eachPet()[0];
    if (first === undefined) {
      die('no pets installed. Install one first: petctl gallery && petctl install <pet-id>');
    }
    writeJsonAtomic(CURRENT_JSON, { id: first.id, dir: first.dir });
    log(`no pet selected; defaulting to ${first.id}`);
  }
  if (daemonAlive()) {
    // A daemon left over from before a plugin update runs stale code;
    // restart it. Old (pre-version-file) daemons are left alone.
    const pluginVersion = readJson(path.join(SCRIPT_DIR, '..', 'kimi.plugin.json'))?.version;
    const info = readJson(path.join(RUN_DIR, 'daemon-info.json'));
    if (pluginVersion && typeof info?.version === 'string' && info.version !== pluginVersion) {
      log(`daemon v${info.version} != plugin v${pluginVersion}; restarting daemon...`);
      await cmdDismiss();
    } else {
      log(`daemon already running (pid ${daemonPid()}).`);
      return;
    }
  }
  ensureRunDir();
  let command = daemonCommand();
  if (command === undefined) {
    const bin = await downloadDaemonBinary();
    if (bin !== undefined) command = { cmd: bin, args: [] };
  }
  if (command === undefined) {
    ensureDaemonEnv();
    command = { cmd: VENV_PYTHON, args: [DAEMON_PY] };
  }
  // Plain fd (not fs.WriteStream): a stream would keep petctl's event loop
  // alive and the process would never exit after spawning the daemon.
  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn(command.cmd, command.args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(PID_FILE, String(child.pid));
  log(`pet summoned (pid ${child.pid}, ${path.basename(command.cmd)}). Logs: ${LOG_FILE}`);
}

async function cmdUpdateDaemon() {
  const bin = daemonBinaryPath();
  if (bin === undefined) die(`no prebuilt daemon for ${process.platform}/${process.arch}.`);
  rmSync(bin, { force: true });
  const downloaded = await downloadDaemonBinary();
  if (downloaded === undefined) die('download failed; binary left removed (venv still works).');
  log(`daemon binary updated: ${downloaded}`);
  if (daemonAlive()) log('restart the pet to use it: petctl dismiss && petctl summon');
}

async function cmdDismiss() {
  ensureRunDir();
  writeJsonAtomic(CONTROL_JSON, { cmd: 'quit' });
  const pid = daemonPid();
  if (pid !== undefined && daemonAlive()) {
    for (let i = 0; i < 10 && daemonAlive(); i += 1) await sleep(300);
    if (daemonAlive()) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      await sleep(500);
      if (daemonAlive()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  }
  rmSync(PID_FILE, { force: true });
  log('pet dismissed.');
}

function cmdStatus() {
  log(daemonAlive() ? `daemon: running (pid ${daemonPid()})` : 'daemon: not running');
  log(`active pet: ${existsSync(CURRENT_JSON) ? readFileSync(CURRENT_JSON, 'utf8').trim() : 'none selected'}`);
  const sessions = existsSync(SESSIONS_DIR)
    ? readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
    : [];
  log(`session states: ${sessions.length}`);
  for (const file of sessions) {
    console.log(`  ${file}: ${readFileSync(path.join(SESSIONS_DIR, file), 'utf8').trim()}`);
  }
}

function cmdList() {
  const pets = eachPet();
  if (pets.length === 0) {
    log('no pets installed. Browse the gallery: petctl gallery');
    return;
  }
  for (const { id, dir } of pets) {
    const meta = readJson(path.join(dir, 'pet.json')) ?? {};
    const source = dir.startsWith(CODEX_PETS) ? 'codex' : 'kimi';
    console.log(`${id.padEnd(32)} [${source}] ${meta.displayName ?? ''}`);
  }
}

async function cmdGallery() {
  const resp = await fetch(`${GALLERY_RAW}/pets.json`);
  if (!resp.ok) die(`failed to fetch gallery: HTTP ${resp.status}`);
  const pets = await resp.json();
  for (const pet of pets) {
    console.log(`${pet.slug}\t${pet.name ?? pet.slug} (license: ${pet.license ?? 'unknown'})`);
  }
}

async function cmdInstall(arg) {
  if (!arg) die('install needs a gallery slug or a local directory.');
  if (existsSync(arg)) {
    const petJson = path.join(arg, 'pet.json');
    if (!existsSync(petJson)) die(`${arg} has no pet.json`);
    const meta = readJson(petJson);
    const id = typeof meta?.id === 'string' && meta.id ? meta.id : path.basename(arg);
    if (readdirSync(arg).filter((f) => f.startsWith('spritesheet.')).length === 0) {
      die(`${arg} has no spritesheet`);
    }
    cpSync(arg, path.join(PET_HOME, id), { recursive: true });
    log(`installed local pet ${id} -> ${path.join(PET_HOME, id)}`);
    return;
  }
  if (!SLUG_RE.test(arg)) die(`invalid pet id: ${arg} (expected format: pet-slug--author-slug)`);
  const target = path.join(PET_HOME, arg);
  mkdirSync(target, { recursive: true });
  for (const file of ['pet.json', 'spritesheet.webp']) {
    const resp = await fetch(`${GALLERY_RAW}/pets/${arg}/${file}`);
    if (!resp.ok) die(`failed to download ${file} for ${arg}: HTTP ${resp.status}`);
    writeFileSync(path.join(target, file), Buffer.from(await resp.arrayBuffer()));
  }
  log(`installed ${arg} -> ${target}`);
  log('note: gallery pets may be fan art (CC BY-NC etc.) — personal use only.');
}

function cmdUse(id) {
  if (!id) die('use needs a pet id (see: petctl list).');
  const dir = findPetDir(id);
  if (dir === undefined) die(`pet not installed: ${id} (see: petctl list)`);
  writeJsonAtomic(CURRENT_JSON, { id, dir });
  writeJsonAtomic(CONTROL_JSON, { cmd: 'reload' });
  log(`active pet: ${id}`);
}

function cmdHome() {
  console.log(`kimi home:    ${KIMI_HOME}`);
  console.log(`pet home:     ${PET_HOME}`);
  console.log(`run dir:      ${RUN_DIR}`);
  console.log(`venv:         ${VENV_DIR}`);
  console.log(`codex pets:   ${CODEX_PETS} (read-only fallback)`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'summon':
      return cmdSummon(args[0]);
    case 'dismiss':
      return cmdDismiss();
    case 'update-daemon':
      return cmdUpdateDaemon();
    case 'status':
      return cmdStatus();
    case 'list':
      return cmdList();
    case 'gallery':
      return cmdGallery();
    case 'install':
      return cmdInstall(args[0]);
    case 'use':
      return cmdUse(args[0]);
    case 'home':
      return cmdHome();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return undefined;
    default:
      console.log(USAGE);
      return die(`unknown command: ${cmd}`);
  }
}

try {
  await main();
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
