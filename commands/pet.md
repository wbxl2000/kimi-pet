---
description: Summon, dismiss, or manage the kimi-pet desktop pet (codex-compatible pets).
---

Manage the kimi-pet desktop pet by running its `petctl` helper with the Bash tool. Interpret the user's intent from: $ARGUMENTS

The helper lives at (use this exact path; quote it). It's a node script — node is guaranteed wherever Kimi Code runs, on any platform:

```bash
PETCTL="${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-pet/bin/petctl.mjs"
```

Subcommands (run as `node "$PETCTL" <subcommand>`):

- `node "$PETCTL" summon [pet-id]` — start the desktop pet. This is the default when no arguments are given. The first summon creates a Python venv under `~/.kimi-code/pets/venv` and installs PySide6 (one-time, ~100MB download) — tell the user before running it.
- `node "$PETCTL" dismiss` — stop the pet.
- `node "$PETCTL" status` — show daemon state, active pet, and live session states.
- `node "$PETCTL" list` — list installed pets (kimi home plus `~/.codex/pets` fallback).
- `node "$PETCTL" gallery` — list pets in the awesome-codex-pet community gallery.
- `node "$PETCTL" install <pet-slug--author-slug | local-dir>` — install a pet from the gallery or copy a local pet directory.
- `node "$PETCTL" use <pet-id>` — switch the active pet.

Behavior rules:

- If the user gives no arguments, run `summon`.
- If no pet is installed yet, run `gallery`, let the user pick, then `install` and `summon` it. Mention that gallery pets are community fan art, often CC BY-NC — personal, non-commercial use only.
- After each command, report the result briefly. If `summon` fails, show the tail of `~/.kimi-code/pets/run/daemon.log` and suggest fixes (missing python3, blocked download).
