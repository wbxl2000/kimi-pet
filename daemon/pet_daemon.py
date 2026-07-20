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
from PySide6.QtGui import QIcon, QImage, QPainter, QPixmap
from PySide6.QtWidgets import QApplication, QLabel, QMenu, QSystemTrayIcon, QWidget

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
# Per-frame hold ticks for the calm states (1 tick = one animation timer
# interval at the state's fps; rows shorter than the list reuse the last
# value). Mimics the codex pet renderer: hold the quiet frames so the pet is
# mostly still with only occasional motion instead of fidgeting at full fps.
FRAME_HOLDS = {
    "idle": [16, 5, 5, 5, 5, 5],
    "review": [12, 5, 5, 5, 5, 5],
    "waiting": [10, 5, 5, 5, 5, 5],
}
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
            row_frames.append(QPixmap.fromImage(cell))  # native 192x208; scaled at paint time
        if row_frames:
            frames[state] = row_frames
    if "idle" not in frames:
        raise RuntimeError(f"spritesheet has no idle row: {sheet_path}")
    return frames


class BubbleWindow(QWidget):
    """Click-through speech bubble floating above the pet.

    Shows the live session summary: how many sessions are active, which
    project the top one is in, and what it is currently doing.
    """

    MAX_WIDTH = 280

    def __init__(self) -> None:
        super().__init__()
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool,
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        if hasattr(Qt.WidgetAttribute, "WA_MacAlwaysShowToolWindow"):
            self.setAttribute(Qt.WidgetAttribute.WA_MacAlwaysShowToolWindow)
        self.label = QLabel(self)
        self.label.setWordWrap(True)
        self.label.setMaximumWidth(self.MAX_WIDTH)
        self.label.setStyleSheet(
            "QLabel { background: rgba(255, 255, 255, 235); color: #222;"
            " border-radius: 10px; padding: 6px 10px; font-size: 12px; }"
        )

    def set_text(self, text: str) -> None:
        if not text:
            self.hide()
            return
        self.label.setText(text)
        self.label.adjustSize()
        self.resize(self.label.sizeHint())
        self.show()

    def place_near(self, pet_geom, screen_area) -> None:
        """Float above the pet (right-aligned); flip below when off-screen."""
        x = pet_geom.right() - self.width()
        x = max(screen_area.left() + 8, min(x, screen_area.right() - self.width() - 8))
        y = pet_geom.top() - self.height() - 8
        if y < screen_area.top() + 8:
            y = pet_geom.bottom() + 8
        self.move(x, y)


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
        self._hold_left = 1  # remaining hold ticks for the current quiet frame
        self._notified_key: tuple | None = None  # last (state, ts) we notified for

        self.bubble = BubbleWindow()
        self.tray = QSystemTrayIcon(self)
        self.tray.setToolTip("kimi-pet")
        tray_menu = QMenu()
        tray_quit = tray_menu.addAction("Quit kimi-pet")
        tray_quit.triggered.connect(QApplication.quit)
        self.tray.setContextMenu(tray_menu)
        self.tray.show()

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
        self.setFixedSize(round(CELL_W * SCALE), round(CELL_H * SCALE))  # 115x125 points
        self.tray.setIcon(QIcon(self.frames["idle"][0]))
        self.tray.setToolTip(f"kimi-pet — {self.pet_name}")
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
        holds = FRAME_HOLDS.get(name)
        self._hold_left = holds[0] if holds is not None else 1
        self.anim_timer.start(max(1, round(1000 / FPS_BY_STATE.get(name, 7))))

    def _play_oneshot(self, name: str) -> None:
        if name not in self.frames:
            return
        self.oneshot = name
        self._set_animation(name)

    def _active_animation(self) -> str:
        return self.oneshot or self.state

    def _advance_frame(self) -> None:
        active = self._active_animation()
        frames = self.frames.get(active) or self.frames.get("idle") or []
        if not frames:
            return
        holds = FRAME_HOLDS.get(active)
        if holds is not None and self._hold_left > 1:
            self._hold_left -= 1  # quiet frame: stay put, skip the repaint
            return
        self.frame_index += 1
        if self.frame_index >= len(frames):
            self.frame_index = 0
            if self.oneshot is not None:
                self.oneshot = None
                self._set_animation(self.state)
                return
        if holds is not None:
            self._hold_left = holds[min(self.frame_index, len(holds) - 1)]
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802 (Qt override)
        frames = self.frames.get(self._active_animation()) or self.frames.get("idle")
        if not frames:
            return
        painter = QPainter(self)
        # Resample the native-resolution frame straight into the window rect.
        # Qt maps points to the backing store's device pixels, so this stays
        # crisp on Retina (and adapts when the window moves across screens).
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        painter.drawPixmap(self.rect(), frames[self.frame_index % len(frames)])
        painter.end()

    # -- state polling -------------------------------------------------

    def _poll(self) -> None:
        self._consume_control()
        self.reload_pet()
        state, top, count = self._aggregate()
        self._apply_state(state)
        self._notify(state, top)
        self._update_bubble(state, top, count)

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

    def _aggregate(self) -> tuple[str, dict | None, int]:
        """Pick the live session with the highest-priority state.

        Returns (state, top_session_data, live_session_count). Decayed and
        stale sessions count for neither.
        """
        sessions = run_dir() / "sessions"
        top: dict | None = None
        top_key = (-1, 0.0)
        count = 0
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
                count += 1
                key = (STATE_PRIORITY.get(state, 0), float(data.get("ts", 0)))
                if key > top_key:
                    top_key = key
                    top = {**data, "state": state}
        return ((top["state"] if top is not None else "idle"), top, count)

    def _apply_state(self, state: str) -> None:
        if state == self.state:
            return
        self.state = state
        if self.oneshot is None:
            self._set_animation(state)

    # -- bubble & notifications ------------------------------------------

    def _bubble_text(self, state: str, top: dict | None, count: int) -> str:
        if top is None or state == "idle":
            return ""
        text = top.get("text") if isinstance(top.get("text"), str) else None
        tool = top.get("tool_name") if isinstance(top.get("tool_name"), str) else None
        if state == "running":
            body = text or "工作中…"
        elif state == "waiting":
            body = f"等待确认：{tool or text or '权限请求'}"
        elif state == "failed":
            body = f"出错了：{tool or text or '工具失败'}"
        elif state == "review":
            if top.get("event") == "Notification":
                body = text or "新通知"
            else:
                body = f"完成：{text}" if text else "任务完成"
        else:
            return ""
        prefix = f"{count} 个会话 · " if count > 1 else ""
        project = top.get("project")
        if isinstance(project, str) and project:
            prefix += f"{project}｜"
        return prefix + body

    def _update_bubble(self, state: str, top: dict | None, count: int) -> None:
        text = self._bubble_text(state, top, count)
        self.bubble.set_text(text)
        if text:
            screen = QApplication.screenAt(self.geometry().center())
            screen = screen or QApplication.primaryScreen()
            if screen is not None:
                self.bubble.place_near(self.geometry(), screen.availableGeometry())

    def _notify(self, state: str, top: dict | None) -> None:
        """Native notification + beep for things that need the user's attention."""
        if top is None:
            return
        key = (state, float(top.get("ts", 0)))
        if key == self._notified_key:
            return
        project = top.get("project") if isinstance(top.get("project"), str) else ""
        if state == "waiting":
            self._notified_key = key
            QApplication.beep()  # permission needed — nudge the user
            tool = top.get("tool_name") or "权限请求"
            self.tray.showMessage(
                "kimi-pet：等待确认",
                f"{project}｜{tool}" if project else str(tool),
                QSystemTrayIcon.MessageIcon.Information,
                8000,
            )
        elif state == "review" and top.get("event") == "Notification":
            self._notified_key = key
            text = top.get("text") or "新通知"
            self.tray.showMessage(
                project or "kimi-pet",
                str(text),
                QSystemTrayIcon.MessageIcon.Information,
                8000,
            )

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
        if self.bubble.isVisible():
            screen = QApplication.screenAt(self.geometry().center())
            screen = screen or QApplication.primaryScreen()
            if screen is not None:
                self.bubble.place_near(self.geometry(), screen.availableGeometry())

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
