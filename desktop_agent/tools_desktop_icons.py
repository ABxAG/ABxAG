"""Desktop icon positions, for the companion's "play with the icons" game.

Uses the documented Shell interfaces (IShellWindows -> the desktop's
IShellBrowser -> IFolderView): GetItemPosition / SelectAndPositionItems. No
memory of Explorer is read or written. Positions are desktop list-view
coordinates in physical pixels (the item's top-left).

The companion saves the original position of every icon it moves and puts
them back on request; this module only reads and moves.
"""

from __future__ import annotations

import platform
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from .registry import ToolError, register

_EXECUTOR: Optional[ThreadPoolExecutor] = None
_LOCK = threading.Lock()


def _executor() -> ThreadPoolExecutor:
    """COM objects stay on one apartment thread."""
    global _EXECUTOR
    with _LOCK:
        if _EXECUTOR is None:
            def init() -> None:
                import pythoncom

                pythoncom.CoInitialize()

            _EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="abxag-icons", initializer=init)
        return _EXECUTOR


def _folder_view():
    import pythoncom
    import win32com.client
    from win32com.shell import shell, shellcon

    windows = win32com.client.Dispatch("{9BA05972-F6A8-11CF-A442-00A0C90A8F39}")  # ShellWindows
    desktop = windows.FindWindowSW(shellcon.CSIDL_DESKTOP, None, 8, 0, 1)  # SWC_DESKTOP, SWFO_NEEDDISPATCH
    provider = desktop._oleobj_.QueryInterface(pythoncom.IID_IServiceProvider)
    top_level_browser = pythoncom.MakeIID("{4C96BE40-915C-11CF-99D3-00AA004AE837}")
    browser = provider.QueryService(top_level_browser, shell.IID_IShellBrowser)
    view = browser.QueryActiveShellView().QueryInterface(shell.IID_IFolderView)
    folder = view.GetFolder(shell.IID_IShellFolder)
    return view, folder


def _list() -> Dict[str, Any]:
    from win32com.shell import shellcon

    view, folder = _folder_view()
    items: List[Dict[str, Any]] = []
    for index in range(view.ItemCount(shellcon.SVGIO_ALLVIEW)):
        pidl = view.Item(index)
        try:
            name = folder.GetDisplayNameOf([pidl], shellcon.SHGDN_NORMAL)
            x, y = view.GetItemPosition(pidl)
        except Exception:
            continue
        items.append({"name": str(name), "x": int(x), "y": int(y)})
    try:
        spacing = view.GetDefaultSpacing()
    except Exception:
        spacing = (96, 100)
    return {
        "items": items,
        # pywin32 maps the HRESULT to a bool: true when auto-arrange is on.
        "auto_arrange": bool(view.GetAutoArrange()),
        "spacing": {"width": int(spacing[0]), "height": int(spacing[1])},
    }


def _move(name: str, x: int, y: int) -> Dict[str, Any]:
    from win32com.shell import shellcon

    view, folder = _folder_view()
    for index in range(view.ItemCount(shellcon.SVGIO_ALLVIEW)):
        pidl = view.Item(index)
        try:
            if str(folder.GetDisplayNameOf([pidl], shellcon.SHGDN_NORMAL)) != name:
                continue
        except Exception:
            continue
        view.SelectAndPositionItem(pidl, (int(x), int(y)), 0x80)  # SVSI_POSITIONITEM
        nx, ny = view.GetItemPosition(pidl)
        return {"name": name, "x": int(nx), "y": int(ny)}
    raise ToolError(f"No desktop icon named '{name}'.")


def _run(fn, *args):
    if platform.system() != "Windows":
        raise ToolError("Desktop icons are available on Windows only.")
    try:
        return _executor().submit(fn, *args).result(timeout=8)
    except ToolError:
        raise
    except Exception as error:
        raise ToolError(f"Desktop icons are unavailable: {error}") from error


@register("desktopIcons")
def desktop_icons(args: Dict[str, Any]) -> Dict[str, Any]:
    result = _run(_list)
    result["result"] = f"{len(result['items'])} desktop icons."
    return result


@register("moveDesktopIcon")
def move_desktop_icon(args: Dict[str, Any]) -> Dict[str, Any]:
    name = str(args.get("name") or "").strip()
    if not name:
        raise ToolError("Parameter 'name' is required.")
    try:
        x, y = int(args.get("x")), int(args.get("y"))
    except (TypeError, ValueError) as error:
        raise ToolError("Parameters 'x' and 'y' must be integers.") from error
    if not (-20000 < x < 20000 and -20000 < y < 20000):
        raise ToolError("Position out of range.")
    result = _run(_move, name, x, y)
    result["result"] = f"Moved '{name}'."
    return result


__all__ = ["desktop_icons", "move_desktop_icon"]

