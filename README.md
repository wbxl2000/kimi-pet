# kimi-pet

Desktop pet companion for Kimi Code, compatible with the [Codex pet](https://github.com/legeling/awesome-codex-pet) asset ecosystem.

An always-on-top pixel pet floats on your desktop and mirrors what Kimi Code is doing:

| Pet state | Triggered by |
| --- | --- |
| `running` | prompt submitted, tool calls, compaction, subagents (decays after 10 min without events) |
| `waiting` | a permission request needs your decision (beeps) — never decays |
| `review` | turn finished (`Stop`) / background notification (celebrates for ~60s, then back to idle) |
| `failed` | tool or turn failure (decays after a few seconds) |
| `idle` | session open but quiet |
| `waving` / `jumping` | pet appears / mouse hover |

Multiple concurrent Kimi Code sessions are aggregated by priority: `waiting > failed > running > review > idle`.

A speech bubble floats above the pet showing the live summary: active session count (`2 个会话`), the project name, and what the top session is doing — the current prompt while running, the tool awaiting permission, or the finished task. Click the bubble to dismiss it until the next state change. Permission requests and `Notification` events also fire native notifications via the menu-bar tray icon, which doubles as a quit menu and shows an update notice when a new release is out. The pet remembers the spot you dragged it to (`run/position.json`).

## How it works

```
Kimi Code session events
  → plugin hooks (hooks/pet-hook.mjs, fire-and-forget, node)
  → <kimi_home>/pets/run/sessions/<session_id>.json   (state files, tmp+rename)
  → pet daemon (daemon/pet_daemon.py, PySide6) polls every 250 ms
  → frameless transparent always-on-top window
```

The plugin itself is declarative — hooks, a slash command, and a skill. The GUI daemon is spawned only when you explicitly summon the pet.

- Pet assets follow the codex layout: `~/.kimi-code/pets/<pet-id>/{pet.json,spritesheet.webp}`.
- `~/.codex/pets/` is read automatically as a fallback, so pets you already installed for Codex just work.
- The [awesome-codex-pet](https://github.com/legeling/awesome-codex-pet) gallery installs via `petctl install <slug>`. Most gallery pets are fan art (CC BY-NC or similar): personal, non-commercial use only.

## Install

Inside Kimi Code:

```
/plugins install https://github.com/wbxl2000/kimi-pet
```

(It's a third-party plugin, so Kimi Code asks for an install-trust confirmation once.) Or install from a local clone: `/plugins install /path/to/kimi-pet`.

## Usage

Inside Kimi Code, just ask: `/pet` (plugin command `kimi-pet:pet`), or tell the agent to summon/dismiss the pet.

From a shell — `petctl` is a zero-dependency node script (node is guaranteed wherever Kimi Code runs), so the same command works on macOS, Linux, and Windows:

```bash
node bin/petctl.mjs gallery                 # browse the community gallery
node bin/petctl.mjs install doro--lingxiaotian
node bin/petctl.mjs summon                  # first run creates a venv + installs PySide6 (~100MB)
node bin/petctl.mjs use <pet-id>            # switch pet
node bin/petctl.mjs status
node bin/petctl.mjs dismiss
```

(`bin/petctl` remains as a bash wrapper for muscle memory; on Windows call `node bin\petctl.mjs` directly.)

Requirements: `node` (guaranteed wherever Kimi Code runs). On first summon, petctl downloads a prebuilt single-file daemon binary for your platform from the release page — **no Python needed** in the common case. It falls back to creating a venv (`python3` required) when no prebuilt binary exists for your platform/arch, and prefers the venv when one already exists so plugin updates always run fresh daemon code. Refresh the binary with `node bin/petctl.mjs update-daemon`. Platforms: macOS (arm64/x64), Linux (x64), Windows (x64); the binaries are built by [CI](.github/workflows/build-daemon.yml).

## Creating your own pet

Ask the agent to "hatch a pet" — the bundled `hatch-pet` skill walks through building a codex-compatible spritesheet (8×9 grid of 192×208 cells, 1536×1872 WebP) and installing it.

## Layout

```
kimi.plugin.json          # manifest: hooks + commands + skills
hooks/pet-hook.mjs        # session event -> state file (node, zero-dep)
bin/petctl.mjs            # daemon control + pet installer (node, zero-dep, cross-platform)
bin/petctl                # bash wrapper around petctl.mjs
daemon/pet_daemon.py      # the floating window (PySide6)
daemon/requirements.txt
commands/pet.md           # /pet slash command
skills/hatch-pet/SKILL.md # pet authoring skill
```
