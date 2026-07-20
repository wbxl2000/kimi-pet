#!/usr/bin/env python3
"""kimi-pet desktop daemon.

Renders a codex-compatible pet (pet.json + spritesheet.webp) as a frameless,
always-on-top floating window, and drives its animation from Kimi Code session
hook state files. Everything is file-based and polled — no sockets:

  <kimi_home>/pets/run/current.json        {"id": ..., "dir": ...}  active pet (written by petctl)
  <kimi_home>/pets/run/control.json        {"cmd": "quit"|"reload"} one-shot command (consumed)
  <kimi_home>/pets/run/sessions/<sid>.json {"state": ..., "ts": ...} per-session hook states

Spritesheet format (codex-compatible): 8 columns x N rows of 192x208 RGBA
cells. Each row is one animation state, frames left-aligned; the first fully
transparent cell ends the row. v1 sheets have 9 rows; v2 sheets append extra
rows (look directions) that are ignored.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from pathlib import Path

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QImage, QPainter, QPixmap
from PySide6.QtWidgets import QApplication, QMenu, QWidget

CELL_W, CELL_H = 192, 208
SCALE = 0.6

# Spritesheet row layout: row index -> (state name, frames per second).
ROW_STATES = [
    ("idle", 7),
    ("running-right", 10),
    ("running-left", 10),
    ("waving", 8),
    ("jumping", 10),
    ("failed", 7),
    ("waiting", 7),
    ("running", 10),
    ("review", 8),
]
FPS_BY_STATE = dict(ROW_STATES)

# Higher priority wins when several sessions disagree on the state.
STATE_PRIORITY = {"waiting": 5, "failed": 4, "running": 3, "review": 2, "idle": 1}
# Sticky states decay back to idle after this many seconds without a newer
# event — otherwise a finished turn would celebrate (or a crashed session
# would "work") forever. `waiting` never decays: a pending permission
# request must stay visible.
STATE_TTL_S = {"failed": 8.0, "review": 60.0, "running": 10 * 60.0}
SESSION_STALE_S = 15 * 60  # reap sessions whose CLI died without SessionEnd
POLL_INTERVAL_MS = 250


def kimi_home() -> Path:
    return Path(os.environ.get("KIMI_CODE_HOME") or Path.home() / ".kimi-code")


def run_dir() -> Path:
    return kimi_home() / "pets" / "run"


def read_json(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def cell_fully_transparent(cell: QImage) -> bool:
    alpha = cell.convertToFormat(QImage.Format.Format_Alpha8)
    return not any(bytes(alpha.constBits()))


def load_frames(sheet_path: Path) -> dict[str, list[QPixmap]]:
    image = QImage(str(sheet_path))
    if image.isNull():
        raise RuntimeError(f"cannot load spritesheet: {sheet_path}")
    frames: dict[str, list[QPixmap]] = {}
    rows = min(len(ROW_STATES), image.height() // CELL_H)
    cols = image.width() // CELL_W
    for row in range(rows):
        state, _fps = ROW_STATES[row]
        row_frames: list[QPixmap] = []
        for col in range(cols):
            cell = image.copy(col * CELL_W, row * CELL_H, CELL_W, CELL_H)
            if cell_fully_transparent(cell):
                break
            row_frames.append(
                QPixmap.fromImage(cell).scaled(
                    round(CELL_W * SCALE),
                    round(CELL_H * SCALE),
                    Qt.AspectRatioMode.KeepAspectRatio,
                    Qt.TransformationMode.FastTransformation,  # keep the pixel-art look
                )
            )
        if row_frames:
            frames[state] = row_frames
    if "idle" not in frames:
        raise RuntimeError(f"spritesheet has no idle row: {sheet_path}")
    return frames


class PetWindow(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool,  # no taskbar/dock entry
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        # macOS auto-hides Tool windows when the (never-activated) daemon app
        # loses focus; keep the pet visible regardless.
        if hasattr(Qt.WidgetAttribute, "WA_MacAlwaysShowToolWindow"):
            self.setAttribute(Qt.WidgetAttribute.WA_MacAlwaysShowToolWindow)

        self.frames: dict[str, list[QPixmap]] = {}
        self.pet_dir: Path | None = None
        self.pet_name = "kimi-pet"
        self.state = "idle"
        self.oneshot: str | None = None  # transient animation layered over self.state
        self.frame_index = 0
        self.drag_offset = None
        self._last_drag_x = 0

        self.anim_timer = QTimer(self, timeout=self._advance_frame)
        self.poll_timer = QTimer(self, timeout=self._poll, interval=POLL_INTERVAL_MS)

        self.reload_pet()
        self._set_animation("idle")
        self._place_initial()
        self.poll_timer.start()
        if self.frames:
            self.show()

    # -- pet loading ---------------------------------------------------

    def reload_pet(self) -> None:
        current = read_json(run_dir() / "current.json")
        pet_dir = Path(current["dir"]) if current and current.get("dir") else None
        if pet_dir is None or pet_dir == self.pet_dir:
            return
        meta = read_json(pet_dir / "pet.json") or {}
        sheet = pet_dir / meta.get("spritesheetPath", "spritesheet.webp")
        try:
            self.frames = load_frames(sheet)
        except RuntimeError as exc:
            print(f"kimi-pet: {exc}", file=sys.stderr)
            return
        self.pet_dir = pet_dir
        self.pet_name = str(meta.get("displayName") or pet_dir.name)
        self.setFixedSize(self.frames["idle"][0].size())
        self._play_oneshot("waving")
        self._place_initial()
        self.show()

    def _place_initial(self) -> None:
        screen = QApplication.primaryScreen()
        if screen is None or not self.frames:
            return
        area = screen.availableGeometry()
        self.move(area.right() - self.width() - 48, area.bottom() - self.height() - 24)

    # -- animation -----------------------------------------------------

    def _set_animation(self, name: str) -> None:
        self.frame_index = 0
        self.anim_timer.start(max(1, round(1000 / FPS_BY_STATE.get(name, 7))))

    def _play_oneshot(self, name: str) -> None:
        if name not in self.frames:
            return
        self.oneshot = name
        self._set_animation(name)

    def _active_animation(self) -> str:
        return self.oneshot or self.state

    def _advance_frame(self) -> None:
        frames = self.frames.get(self._active_animation()) or self.frames.get("idle") or []
        if not frames:
            return
        self.frame_index += 1
        if self.frame_index >= len(frames):
            self.frame_index = 0
            if self.oneshot is not None:
                self.oneshot = None
                self._set_animation(self.state)
                return
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802 (Qt override)
        frames = self.frames.get(self._active_animation()) or self.frames.get("idle")
        if not frames:
            return
        painter = QPainter(self)
        painter.drawPixmap(0, 0, frames[self.frame_index % len(frames)])
        painter.end()

    # -- state polling -------------------------------------------------

    def _poll(self) -> None:
        self._consume_control()
        self.reload_pet()
        self._apply_state(self._aggregate_state())

    def _consume_control(self) -> None:
        control = run_dir() / "control.json"
        data = read_json(control)
        if data is None:
            return
        try:
            control.unlink()
        except OSError:
            pass
        cmd = data.get("cmd")
        if cmd == "quit":
            QApplication.quit()
        elif cmd == "reload":
            self.pet_dir = None  # force reload_pet to re-read current.json
            self.reload_pet()

    def _aggregate_state(self) -> str:
        sessions = run_dir() / "sessions"
        best = "idle"
        now = time.time()
        if sessions.is_dir():
            for entry in sessions.glob("*.json"):
                try:
                    if now - entry.stat().st_mtime > SESSION_STALE_S:
                        entry.unlink()
                        continue
                except OSError:
                    continue
                data = read_json(entry)
                if not data:
                    continue
                state = str(data.get("state", "idle"))
                ttl = STATE_TTL_S.get(state)
                if ttl is not None and now - float(data.get("ts", 0)) > ttl:
                    continue
                if STATE_PRIORITY.get(state, 0) > STATE_PRIORITY.get(best, 0):
                    best = state
        return best

    def _apply_state(self, state: str) -> None:
        if state == self.state:
            return
        was_waiting = self.state == "waiting"
        self.state = state
        if state == "waiting" and not was_waiting:
            QApplication.beep()  # permission needed — nudge the user
        if self.oneshot is None:
            self._set_animation(state)

    # -- mouse interaction ----------------------------------------------

    def mousePressEvent(self, event) -> None:  # noqa: N802 (Qt override)
        if event.button() == Qt.MouseButton.LeftButton:
            self.drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            self._last_drag_x = event.globalPosition().toPoint().x()
        elif event.button() == Qt.MouseButton.RightButton:
            self._show_menu(event.globalPosition().toPoint())

    def mouseMoveEvent(self, event) -> None:  # noqa: N802 (Qt override)
        if self.drag_offset is None:
            return
        point = event.globalPosition().toPoint()
        dx = point.x() - self._last_drag_x
        self._last_drag_x = point.x()
        if dx:
            drag_state = "running-right" if dx > 0 else "running-left"
            if drag_state in self.frames and self._active_animation() != drag_state:
                self.oneshot = None
                self._set_animation(drag_state)
        self.move(point - self.drag_offset)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 (Qt override)
        if self.drag_offset is not None:
            self.drag_offset = None
            self._set_animation(self._active_animation())

    def enterEvent(self, event) -> None:  # noqa: N802 (Qt override)
        if self.state == "idle" and self.oneshot is None:
            self._play_oneshot("jumping")

    def _show_menu(self, global_pos) -> None:
        menu = QMenu(self)
        title = menu.addAction(self.pet_name)
        title.setEnabled(False)
        menu.addSeparator()
        quit_action = menu.addAction("Quit")
        if menu.exec(global_pos) == quit_action:
            QApplication.quit()


def main() -> int:
    run_dir().mkdir(parents=True, exist_ok=True)
    (run_dir() / "sessions").mkdir(parents=True, exist_ok=True)
    pid_file = run_dir() / "daemon.pid"
    pid_file.write_text(str(os.getpid()), encoding="utf-8")

    app = QApplication(sys.argv)
    app.setApplicationName("kimi-pet")
    window = PetWindow()

    # The 250ms poll timer keeps the Python interpreter ticking so these
    # handlers run promptly even while app.exec() blocks in C++.
    signal.signal(signal.SIGTERM, lambda *_: QApplication.quit())
    signal.signal(signal.SIGINT, lambda *_: QApplication.quit())

    try:
        return app.exec()
    finally:
        pid_file.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
