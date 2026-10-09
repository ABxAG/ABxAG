"""Manual integration check (real desktop): Scenario E (window moved) and F (target gone).

Run:  python -m desktop_agent.integration_window_move

SAFETY: this script only ever touches a window it created itself. It records
every Notepad window that already exists, launches a new one, and acts only on
the window that was not there before. It never types into Notepad (Windows 11
Notepad keeps all windows in ONE process with session restore, so typing or
killing could damage the user's own documents) and it never kills processes:
the test window is closed with WM_CLOSE, which on an unmodified window closes
just that window.
"""

from __future__ import annotations

import subprocess
import sys
import time

from desktop_agent.registry import TOOLS, ToolError, load_all

load_all()


def notepad_windows() -> set[int]:
    import win32gui

    found: set[int] = set()

    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd) and win32gui.GetClassName(hwnd) == "Notepad":
            found.add(hwnd)
        return True

    win32gui.EnumWindows(cb, None)
    return found


def wait_for_new_window(existing: set[int], timeout: float = 10.0) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        new = notepad_windows() - existing
        if new:
            return next(iter(new))
        time.sleep(0.3)
    raise RuntimeError("The test's own Notepad window did not appear")


def close_window(hwnd: int) -> None:
    import win32con
    import win32gui

    if win32gui.IsWindow(hwnd):
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)


def main() -> int:
    before = notepad_windows()
    subprocess.Popen(["notepad.exe"])
    hwnd = wait_for_new_window(before)
    results = {}
    try:
        TOOLS["windowControl"]({"hwnd": hwnd, "action": "move_resize", "x": 120, "y": 120, "width": 800, "height": 600})
        time.sleep(0.6)
        snapshot = TOOLS["inspectUi"]({"hwnd": hwnd, "max_elements": 80})
        editor = next((e for e in snapshot["elements"] if e["role"] in ("edit", "document")), None)
        assert editor, f"no text area found: {[(e['role'], e['name']) for e in snapshot['elements']][:20]}"
        before_rect = editor["rect"]
        TOOLS["windowControl"]({"hwnd": hwnd, "action": "move", "x": 520, "y": 260})
        time.sleep(0.5)
        acted = TOOLS["uiAction"]({"element_id": editor["id"], "snapshot_id": snapshot["snapshot_id"], "action": "focus"})
        moved_rect = acted["rect"]
        results["E_window_moved"] = {
            "snapshot_rect": before_rect,
            "live_rect_at_action": moved_rect,
            "moved_since_snapshot": acted["moved_since_snapshot"],
            "shift": (moved_rect["left"] - before_rect["left"], moved_rect["top"] - before_rect["top"]),
        }
        assert acted["moved_since_snapshot"] is True and moved_rect["left"] - before_rect["left"] >= 350, results
        # Scenario F: the target disappears (closed politely; nothing was typed).
        stale_id, stale_snapshot = editor["id"], snapshot["snapshot_id"]
        close_window(hwnd)
        for _ in range(20):
            if hwnd not in notepad_windows():
                break
            time.sleep(0.2)
        try:
            TOOLS["uiAction"]({"element_id": stale_id, "snapshot_id": stale_snapshot, "action": "click"})
            results["F_vanished"] = "UNEXPECTED: action succeeded"
        except ToolError as error:
            results["F_vanished"] = error.message[:90]
        assert results["F_vanished"].startswith("ELEMENT_NOT_FOUND"), results
        print("PASS", results)
        return 0
    finally:
        close_window(hwnd)


if __name__ == "__main__":
    sys.exit(main())
