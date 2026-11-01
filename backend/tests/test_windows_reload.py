"""Exercise real Uvicorn lifespan and process cleanup without binding sockets."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

# The fixture launcher owns an isolated Windows console, so CI does not need an
# attached console and its CTRL_BREAK_EVENT cannot reach pytest or the CI runner.
# Each real ASGI worker waits on its own cleanup barrier; no database or HTTP API
# is involved. The same fixture also validates the Event protocol on POSIX.
FIXTURE = """\
import asyncio
import multiprocessing
import os
from pathlib import Path
import signal
import sys
import threading
import time
from types import SimpleNamespace

sys.path.insert(0, {scripts!r})
import run as launcher
from uvicorn import Config, Server
from windows_reload import ReloadServer, WindowsReload

STATE = Path({state!r})

async def app(scope, receive, send):
    assert scope["type"] == "lifespan"
    pid = os.getpid()
    assert (await receive())["type"] == "lifespan.startup"
    await send({{"type": "lifespan.startup.complete"}})
    (STATE / f"{{pid}}.started").touch()
    assert (await receive())["type"] == "lifespan.shutdown"
    (STATE / f"{{pid}}.cleanup_started").touch()
    while not (STATE / f"{{pid}}.release").exists():
        await asyncio.sleep(0.01)
    (STATE / f"{{pid}}.cleanup_finished").touch()
    await send({{"type": "lifespan.shutdown.complete"}})

class ObservedReload(WindowsReload):
    def should_restart(self):
        changes = super().should_restart()
        (STATE / "watching").touch()
        return changes

def main():
    mode = sys.argv[1]
    if len(sys.argv) == 3:
        config = Config("shutdown_fixture:app", loop="asyncio", log_level="warning",
                        reload=mode == "reload", reload_dirs=[str(STATE)])
        if mode == "reload":
            event = multiprocessing.get_context("spawn").Event()
            ObservedReload(ReloadServer(config, event), sockets=[]).run()
        else:
            Server(config).run(sockets=[])
        return
    original_spawn = launcher.spawn_process
    application = None
    def spawn(command, environment=None):
        nonlocal application
        if application is None:
            application = original_spawn([sys.executable, __file__, mode, "serve"])
            (STATE / "application.pid").write_text(str(application.pid))
            return application
        return original_spawn(command, environment)
    def controls():
        while not (STATE / "stop").exists():
            time.sleep(0.01)
        signal.raise_signal(signal.SIGINT)
        while not (STATE / "repeat_stop").exists():
            time.sleep(0.01)
        # Keep the repeat immediate when both command files are already present.
        # This also exercises pending batches before main enters its finally.
        signal.raise_signal(signal.SIGINT)
        if os.name == "nt":
            signal.raise_signal(signal.SIGBREAK)
    launcher.spawn_process = spawn
    launcher.frontend_command = lambda: [sys.executable, "-c", "import time; time.sleep(60)"]
    launcher.ROOT = STATE
    launcher.load_settings = lambda: SimpleNamespace(
        server=SimpleNamespace(host="127.0.0.1", port=0, dev_port=0),
        database=SimpleNamespace(path=STATE / "unused.db"))
    built_index = STATE / "frontend/dist/index.html"
    built_index.parent.mkdir(parents=True)
    built_index.touch()
    sys.argv = [__file__, "dev" if mode == "reload" else "start"]
    threading.Thread(target=controls, daemon=True).start()
    assert launcher.main() == 0

if __name__ == "__main__":
    main()
"""


def wait_for_file(path: Path, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 15
    while not path.exists():
        assert process.poll() is None, f"Launcher exited before {path.name}"
        assert time.monotonic() < deadline, f"Timed out waiting for {path.name}"
        time.sleep(0.02)


def started_workers(state: Path) -> set[int]:
    return {int(path.stem) for path in state.glob("*.started")}


def wait_for_worker(state: Path, process: subprocess.Popen[bytes], *, after: set[int]) -> int:
    deadline = time.monotonic() + 15
    while not (workers := started_workers(state) - after):
        assert process.poll() is None, "Launcher exited before the ASGI worker started"
        assert time.monotonic() < deadline, "ASGI worker did not start"
        time.sleep(0.02)
    assert len(workers) == 1
    return workers.pop()


def assert_application_alive(state: Path, process: subprocess.Popen[bytes]) -> None:
    assert process.poll() is None, "Launcher exited while ASGI cleanup was blocked"
    pid = int((state / "application.pid").read_text())
    if os.name == "nt":
        inventory = subprocess.check_output(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], text=True
        )
        assert f'"{pid}"' in inventory, "Reloader exited while ASGI cleanup was blocked"
    else:
        os.kill(pid, 0)


@pytest.fixture
def shutdown_fixture(
    tmp_path: Path,
) -> Iterator[Callable[[str], subprocess.Popen[bytes]]]:
    script = tmp_path / "shutdown_fixture.py"
    script.write_text(
        FIXTURE.format(scripts=str(ROOT / "scripts"), state=str(tmp_path)), encoding="utf-8"
    )
    processes: list[subprocess.Popen[bytes]] = []
    output_log = tmp_path / "launcher.log"

    def launch(mode: str) -> subprocess.Popen[bytes]:
        environment = os.environ.copy()
        environment["PYTHONIOENCODING"] = "utf-8"
        with output_log.open("ab") as output:
            process = subprocess.Popen(
                [sys.executable, str(script), mode],
                cwd=tmp_path,
                env=environment,
                stdout=output,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0,
            )
        processes.append(process)
        return process

    yield launch
    # Release all existing and future barriers even if an assertion failed.
    for process in processes:
        (tmp_path / "stop").touch()
        deadline = time.monotonic() + 5
        while process.poll() is None and time.monotonic() < deadline:
            for pid in started_workers(tmp_path):
                (tmp_path / f"{pid}.release").touch()
            time.sleep(0.02)
        if process.poll() is None:
            if os.name == "posix" and (tmp_path / "application.pid").exists():
                try:
                    os.killpg(int((tmp_path / "application.pid").read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.kill()
        process.wait(timeout=5)
    if output_log.exists():
        # Pytest shows captured teardown output on failures, including Windows
        # console processes whose original output was unavailable to the runner.
        print(output_log.read_text(encoding="utf-8", errors="replace"))


@pytest.mark.parametrize("mode", ["start", "reload"])
def test_launcher_waits_for_actual_asgi_cleanup(
    tmp_path: Path,
    shutdown_fixture: Callable[[str], subprocess.Popen[bytes]],
    mode: str,
) -> None:
    process = shutdown_fixture(mode)
    pid = wait_for_worker(tmp_path, process, after=set())
    (tmp_path / "stop").touch()
    wait_for_file(tmp_path / f"{pid}.cleanup_started", process)
    (tmp_path / "repeat_stop").touch()
    # Cross the old five-second launcher timeout on Windows. POSIX intentionally
    # retains its existing bounded shutdown policy and only checks the handshake.
    time.sleep(5.3 if os.name == "nt" else 0.3)
    assert_application_alive(tmp_path, process)
    assert not (tmp_path / f"{pid}.cleanup_finished").exists()
    (tmp_path / f"{pid}.release").touch()
    assert process.wait(timeout=10) == 0
    assert (tmp_path / f"{pid}.cleanup_finished").exists()


@pytest.mark.parametrize("stop_during_reload", [False, True])
def test_reload_joins_old_worker_and_honors_stop_during_cleanup(
    tmp_path: Path,
    shutdown_fixture: Callable[[str], subprocess.Popen[bytes]],
    stop_during_reload: bool,
) -> None:
    process = shutdown_fixture("reload")
    old_pid = wait_for_worker(tmp_path, process, after=set())
    wait_for_file(tmp_path / "watching", process)
    script = tmp_path / "shutdown_fixture.py"
    modified = script.stat().st_mtime + 2
    os.utime(script, (modified, modified))
    wait_for_file(tmp_path / f"{old_pid}.cleanup_started", process)
    if stop_during_reload:
        (tmp_path / "stop").touch()
        (tmp_path / "repeat_stop").touch()
    time.sleep(0.3)
    assert_application_alive(tmp_path, process)
    assert started_workers(tmp_path) == {old_pid}
    (tmp_path / f"{old_pid}.release").touch()
    if not stop_during_reload:
        new_pid = wait_for_worker(tmp_path, process, after={old_pid})
        assert (tmp_path / f"{old_pid}.cleanup_finished").exists()
        (tmp_path / "stop").touch()
        wait_for_file(tmp_path / f"{new_pid}.cleanup_started", process)
        (tmp_path / "repeat_stop").touch()
        assert_application_alive(tmp_path, process)
        (tmp_path / f"{new_pid}.release").touch()
    assert process.wait(timeout=10) == 0
    assert (tmp_path / f"{old_pid}.cleanup_finished").exists()
    assert len(started_workers(tmp_path)) == (1 if stop_during_reload else 2)
