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

From a shell (petctl is also on the plugin dir after install):

```bash
bin/petctl gallery                 # browse the community gallery
bin/petctl install doro--lingxiaotian
bin/petctl summon                  # first run creates a venv + installs PySide6 (~100MB)
bin/petctl use <pet-id>            # switch pet
bin/petctl status
bin/petctl dismiss
```

Requirements: `python3` on PATH (the daemon creates its own venv at `~/.kimi-code/pets/venv`). Platforms: macOS and Linux (X11) tested paths; `petctl` is bash — on Windows run it from Git Bash (the daemon itself is cross-platform Python/Qt).

## Creating your own pet

Ask the agent to "hatch a pet" — the bundled `hatch-pet` skill walks through building a codex-compatible spritesheet (8×9 grid of 192×208 cells, 1536×1872 WebP) and installing it.

## Layout

```
kimi.plugin.json          # manifest: hooks + commands + skills
hooks/pet-hook.mjs        # session event -> state file (node, zero-dep)
bin/petctl                # daemon control + pet installer (bash)
daemon/pet_daemon.py      # the floating window (PySide6)
daemon/requirements.txt
commands/pet.md           # /pet slash command
skills/hatch-pet/SKILL.md # pet authoring skill
```
