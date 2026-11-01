"""Reload Uvicorn on Windows without relying on inherited console Ctrl-C state."""

from __future__ import annotations

import multiprocessing
import signal
import sys
from multiprocessing.synchronize import Event
from pathlib import Path
from socket import socket

from app.config import load_settings
from uvicorn import Config, Server
from uvicorn._subprocess import get_subprocess
from uvicorn.supervisors.statreload import StatReload


class ReloadServer(Server):
    """The shared event requests ordinary ASGI shutdown in the current worker."""

    def __init__(self, config: Config, stop_requested: Event) -> None:
        super().__init__(config)
        self.stop_requested = stop_requested

    async def on_tick(self, counter: int) -> bool:
        should_exit = await super().on_tick(counter)
        return self.stop_requested.is_set() or should_exit


class WindowsReload(StatReload):
    """Join the ASGI worker before acknowledging shutdown or starting its successor."""

    def __init__(self, server: ReloadServer, sockets: list[socket]) -> None:
        # Uvicorn binds once in the supervisor and passes the sockets to each worker.
        super().__init__(server.config, target=server.run, sockets=sockets)
        self.stop_requested = server.stop_requested

    def startup(self) -> None:
        if sys.platform == "win32":
            signal.signal(signal.SIGBREAK, self.signal_handler)
        super().startup()

    def restart(self) -> None:
        # Unlike BaseReload.restart, do not emit CTRL_C_EVENT: the launcher's new
        # process group disables Ctrl-C, and Windows cannot target Ctrl-C by group.
        # is_restarting stays false, so an external stop during reload is not lost.
        self.stop_requested.set()
        self.process.join()
        if self.should_exit.is_set():
            return
        # The old worker has finished lifespan cleanup and can no longer observe
        # this event. Only now may its successor receive a cleared stop request.
        self.stop_requested.clear()
        self.mtimes.clear()
        self.process = get_subprocess(
            config=self.config, target=self.target, sockets=self.sockets
        )
        self.process.start()

    def shutdown(self) -> None:
        self.stop_requested.set()
        self.process.join()
        super().shutdown()


def main() -> None:
    settings = load_settings()
    config = Config(
        "app.main:app",
        host=settings.server.host,
        port=settings.server.port,
        reload=True,
        reload_dirs=[str(Path(__file__).resolve().parents[1] / "backend/src")],
    )
    server = ReloadServer(config, multiprocessing.get_context("spawn").Event())
    reloader = WindowsReload(server, sockets=[config.bind_socket()])
    reloader.run()


if __name__ == "__main__":
    main()
