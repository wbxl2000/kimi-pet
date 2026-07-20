---
name: hatch-pet
description: Create a new kimi-pet / codex-compatible desktop pet — build the spritesheet (pet.json + spritesheet.webp) from a reference image or from scratch, validate it, and install it. Use when the user wants to design, generate, or customize a desktop pet.
---

# Hatch a desktop pet

A pet is a directory containing exactly two files, compatible with the Codex pet format:

```
<pet-id>/
├── pet.json           # {"id", "displayName", "description", "spritesheetPath", "kind"}
└── spritesheet.webp   # 8 columns × 9 rows of 192×208 RGBA cells (1536×1872 total)
```

`<pet-id>` must be lowercase kebab-case, conventionally `pet-slug--author-slug` (e.g. `doro--lingxiaotian`).

## Spritesheet spec

- Canvas: **1536×1872 px**, 8 columns × 9 rows, cell **192×208 px**, RGBA with a **transparent background**.
- Each row is one animation state, frames left-aligned; pad unused cells with transparency. Row layout:

| Row | State | Frames | Used for |
| --- | --- | --- | --- |
| 0 | idle | 6 | breathing / blinking loop |
| 1 | running-right | 8 | dragged to the right |
| 2 | running-left | 8 | dragged to the left |
| 3 | waving | 4 | greeting when the pet appears |
| 4 | jumping | 5 | hover celebration |
| 5 | failed | 8 | tool/turn failure reaction |
| 6 | waiting | 6 | permission needed |
| 7 | running | 6 | actively working |
| 8 | review | 6 | turn finished, output to review |

- Style: chibi pixel art reads best at the rendered size (~115×125 px, 0.6 scale). Keep the character centered in each cell with a few px of margin.

## Workflow

1. Gather the concept: character, palette, mood. If the user provides a reference image, trace its key features; otherwise iterate with the user in chat (describe frames, get confirmation) before rendering.
2. Produce the 57 frames. Practical tooling on the user's machine:
   - Draw programmatically with Python + Pillow (pixel art is very tractable this way), or
   - cut and clean an existing image: resize to 192×208 cells, chroma-key the background (pure magenta `#FF00FF` works well as a key color) to transparency, then compose the grid.
   - Use `.tmp/` or another scratch dir for intermediate frames; assemble per-state rows, then stack the 9 rows.
3. Export as lossless WebP named `spritesheet.webp` (Pillow: `img.save(path, lossless=True)`). Keep the alpha channel.
4. Write `pet.json`, e.g.:

   ```json
   {
     "id": "my-pet--username",
     "displayName": "My Pet",
     "description": "One sentence describing the character and its mood.",
     "spritesheetPath": "spritesheet.webp",
     "kind": "character"
   }
   ```

5. Validate before installing:
   - image is exactly 1536×1872, RGBA;
   - every state row has its frames (a quick way: slice cells with Pillow and assert each expected cell has non-zero alpha);
   - open the sheet yourself and eyeball alignment.
6. Install and activate:

   ```bash
   PETCTL="${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-pet/bin/petctl"
   bash "$PETCTL" install /path/to/<pet-id>   # copies into ~/.kimi-code/pets/
   bash "$PETCTL" use <pet-id>
   bash "$PETCTL" summon
   ```

7. Show the user the result (the pet greets with its waving row) and ask if any state needs tuning.

Do not redistribute gallery or fan-art pets as your own; newly hatched pets default to the user's personal use.
