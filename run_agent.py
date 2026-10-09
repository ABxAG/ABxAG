"""
ABxAG Desktop Control Agent — frozen entrypoint.

This is the script PyInstaller freezes into `abxag.exe`. It runs the
FastAPI agent with uvicorn using the app *object* (not an import string), which
is the reliable way to launch inside a PyInstaller bundle. Logs are written to
the per-user data directory so failures are never silent, even with no console.

Run (frozen):   abxag.exe
Run (dev):      python run_agent.py
Environment:
    ABxAG_AGENT_HOST   default 127.0.0.1
    ABxAG_AGENT_PORT   default 8765
    ABxAG_DATA_DIR     where logs/ is written (default: cwd)
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path


def _resolve_data_dir() -> Path:
    data = os.environ.get("ABxAG_DATA_DIR") or os.getcwd()
    logs = Path(data) / "logs"
    try:
        logs.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return Path(data)


def _configure_logging(data_dir: Path) -> None:
    handlers: list[logging.Handler] = []
    try:
        handlers.append(logging.FileHandler(data_dir / "logs" / "agent.log", encoding="utf-8"))
    except Exception:
        pass
    # When frozen with console=False there is no real stdout, but keeping a
    # stream handler is harmless and helps when run from a terminal in dev.
    handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=handlers,
        force=True,
    )


def main() -> None:
    data_dir = _resolve_data_dir()
    _configure_logging(data_dir)
    log = logging.getLogger("abxag.agent.boot")

    host = os.environ.get("ABxAG_AGENT_HOST", "127.0.0.1")
    port = int(os.environ.get("ABxAG_AGENT_PORT", "8765"))
    frozen = getattr(sys, "frozen", False)
    log.info("Starting ABxAG agent (frozen=%s) on %s:%d", frozen, host, port)

    try:
        from desktop_agent.main import app
        import uvicorn
    except Exception:
        log.exception("Fatal: could not import agent application.")
        raise

    try:
        # The frozen helper uses PyInstaller's windowed bootloader, where
        # sys.stdout is None. Uvicorn's default color formatter calls
        # stdout.isatty() during configuration and crashes before binding the
        # port. ABxAG already configured a rotating destination above, so keep
        # that logger and disable Uvicorn's console-oriented log config.
        uvicorn.run(
            app,
            host=host,
            port=port,
            log_level="info",
            log_config=None,
            access_log=False,
        )
    except Exception:
        log.exception("Fatal: uvicorn exited with an error.")
        raise


if __name__ == "__main__":
    main()



