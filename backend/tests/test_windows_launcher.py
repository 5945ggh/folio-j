"""Exercise the CLI's real Windows console stop without making network requests."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

# An isolated console controller sends CTRL_BREAK to only the CLI's process group.
# The real Uvicorn server binds loopback, but neither process opens a connection.
FIXTURE = """\
import asyncio
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from support_network import install_network_guard

STATE = Path(sys.argv[2])

def denied():
    (STATE / "network-attempt").touch()

install_network_guard(on_denied=denied)

def wait_for(path, process):
    deadline = time.monotonic() + 30
    while not path.exists():
        assert process.poll() is None, f"CLI exited early: {process.returncode}"
        assert time.monotonic() < deadline, f"Timed out waiting for {path.name}"
        time.sleep(0.02)

async def application(scope, receive, send):
    assert scope["type"] == "lifespan"
    assert (await receive())["type"] == "lifespan.startup"
    await send({"type": "lifespan.startup.complete"})
    assert (await receive())["type"] == "lifespan.shutdown"
    (STATE / "cleanup-started").touch()
    while not (STATE / "release").exists():
        await asyncio.sleep(0.01)
    (STATE / "cleanup-finished").touch()
    await send({"type": "lifespan.shutdown.complete"})

def serve():
    from app import launcher
    from app import main as app_main
    from app.config import DatabaseSettings, ServerSettings, Settings

    class ObservedServer(launcher.BrowserServer):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if self.started:
                port = self.servers[0].sockets[0].getsockname()[1]
                (STATE / "ready").write_text(str(port), encoding="ascii")

    launcher.BrowserServer = ObservedServer
    launcher.RESOURCE_ROOT = STATE
    launcher.migrate = lambda database_path: None
    launcher.load_settings = lambda: Settings(
        database=DatabaseSettings(path=STATE / "学习📚𠮷.db"),
        server=ServerSettings(host="127.0.0.1").model_copy(update={"port": 0}))
    app_main.create_app = lambda **kwargs: application
    raise SystemExit(launcher.main(["start", "--no-browser"]))

if sys.argv[1] == "serve":
    serve()
else:
    with (STATE / "cli.log").open("wb") as output:
        process = subprocess.Popen(
            [sys.executable, __file__, "serve", str(STATE)],
            stdout=output, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        try:
            wait_for(STATE / "ready", process)
            wait_for(STATE / "stop", process)
            process.send_signal(signal.CTRL_BREAK_EVENT)
            result = process.wait(timeout=30)
            (STATE / "returncode").write_text(str(result), encoding="ascii")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
"""


def wait_for(path: Path, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 30
    while not path.exists():
        assert process.poll() is None, f"Console controller exited before {path.name}"
        assert time.monotonic() < deadline, f"Timed out waiting for {path.name}"
        time.sleep(0.02)


@pytest.mark.skipif(sys.platform != "win32", reason="Requires Windows console CTRL_BREAK_EVENT")
def test_cli_ctrl_break_finishes_cleanup_exits_zero_and_releases_port(tmp_path: Path) -> None:
    script = tmp_path / "console_fixture.py"
    script.write_text(FIXTURE, encoding="utf-8")
    frontend = tmp_path / "frontend/dist"
    frontend.mkdir(parents=True)
    (frontend / "index.html").touch()
    environment = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join((str(ROOT / "backend/src"), str(ROOT / "backend/tests"))),
        "PYTHONIOENCODING": "cp936",
    }
    with (tmp_path / "controller.log").open("wb") as output:
        process = subprocess.Popen(
            [sys.executable, str(script), "control", str(tmp_path)],
            cwd=tmp_path,
            env=environment,
            stdout=output,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0,
        )
    try:
        wait_for(tmp_path / "ready", process)
        port = int((tmp_path / "ready").read_text(encoding="ascii"))
        with socket.socket() as probe, pytest.raises(OSError):
            probe.bind(("127.0.0.1", port))
        (tmp_path / "stop").touch()
        wait_for(tmp_path / "cleanup-started", process)
        assert process.poll() is None
        assert not (tmp_path / "cleanup-finished").exists()
        (tmp_path / "release").touch()
        assert process.wait(timeout=15) == 0
        assert (tmp_path / "returncode").read_text(encoding="ascii") == "0"
        assert (tmp_path / "cleanup-finished").exists()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
        assert "学习📚𠮷.db" in (tmp_path / "cli.log").read_text(encoding="utf-8")
        assert not (tmp_path / "network-attempt").exists()
    finally:
        (tmp_path / "stop").touch()
        (tmp_path / "release").touch()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                check=False,
                timeout=10,
            )
            process.wait(timeout=5)
        for name in ("controller.log", "cli.log"):
            path = tmp_path / name
            if path.exists():
                print(path.read_text(encoding="utf-8", errors="replace"))
