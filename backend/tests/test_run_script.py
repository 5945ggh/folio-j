"""Protect launcher command construction and cleanup without opening sockets."""

from __future__ import annotations

import importlib.util
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("folio_launcher", ROOT / "scripts/run.py")
assert spec is not None and spec.loader is not None
launcher: Any = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def test_frontend_uses_node_instead_of_a_shell_shim(monkeypatch: pytest.MonkeyPatch) -> None:
    node = "C:/Program Files/Node/node.exe"

    def find_node(_command: str) -> str:
        return node

    monkeypatch.setattr(launcher.shutil, "which", find_node)
    command = launcher.frontend_command()
    assert command == [
        node,
        str(ROOT / "frontend/node_modules/vite/bin/vite.js"),
        str(ROOT / "frontend"),
        "--host",
        "127.0.0.1",
    ]


def test_missing_node_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    def find_nothing(_command: str) -> None:
        return None

    monkeypatch.setattr(launcher.shutil, "which", find_nothing)
    with pytest.raises(FileNotFoundError, match="Node.js"):
        launcher.frontend_command()


@pytest.mark.parametrize("platform", ["nt", "posix"])
def test_main_selects_reload_adapter_and_waits_for_its_application(
    monkeypatch: pytest.MonkeyPatch, platform: str
) -> None:
    commands: list[list[str]] = []
    backend = SimpleNamespace(poll=lambda: None)
    frontend = SimpleNamespace(poll=lambda: 0)
    stopped: list[object] = []

    def spawn(command: list[str], _environment: object = None) -> object:
        commands.append(command)
        return backend if len(commands) == 1 else frontend

    def stop(_processes: object, *, application: object) -> None:
        stopped.append(application)

    def ignore_signal(*_args: object) -> None:
        pass

    def windows_support(_name: str) -> SimpleNamespace:
        return SimpleNamespace(contain_process_tree=lambda: None)

    monkeypatch.setattr(launcher, "os", SimpleNamespace(name=platform, environ=os.environ))
    monkeypatch.setattr(
        launcher,
        "signal",
        SimpleNamespace(SIGINT=2, SIGTERM=15, SIGBREAK=21, SIG_IGN=1, signal=ignore_signal),
    )
    monkeypatch.setattr(
        launcher,
        "import_module",
        windows_support,
    )
    monkeypatch.setattr(launcher.sys, "argv", ["run.py", "dev"])
    monkeypatch.setattr(launcher, "spawn_process", spawn)
    monkeypatch.setattr(launcher, "frontend_command", lambda: ["node", "vite.js"])
    monkeypatch.setattr(launcher, "stop_processes", stop)
    assert launcher.main() == 0
    assert stopped == [backend]
    if platform == "nt":
        assert commands[0] == [sys.executable, str(ROOT / "scripts/windows_reload.py")]
    else:
        assert commands[0][1:3] == ["-m", "uvicorn"]
        assert "--reload" in commands[0]


@pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")
def test_cleanup_signals_group_even_after_its_leader_exits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[int, int]] = []

    def capture_signal(pid: int, sig: int) -> None:
        calls.append((pid, sig))

    monkeypatch.setattr(launcher.os, "killpg", capture_signal)
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait(timeout=10)
    launcher.stop_processes([process])
    assert calls == [(process.pid, signal.SIGTERM)]


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object lifetime")
@pytest.mark.parametrize("forced", [False, True])
def test_windows_job_reaps_descendants_when_launcher_exits(tmp_path: Path, forced: bool) -> None:
    # The launcher itself joins the job before spawning; its child then outlives
    # its immediate parent, which is exactly where taskkill /T alone is insufficient.
    child_pid = tmp_path / "child.pid"
    script = (
        "import subprocess, sys\n"
        f"sys.path.insert(0, {str(ROOT / 'scripts')!r})\n"
        "from windows_process import contain_process_tree\n"
        "contain_process_tree()\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"open({str(child_pid)!r}, 'w').write(str(child.pid))\n"
        + ("import time; time.sleep(60)\n" if forced else "")
    )
    parent = subprocess.Popen([sys.executable, "-c", script])
    try:
        deadline = time.monotonic() + 10
        while not child_pid.exists() or not child_pid.read_text().strip():
            if parent.poll() is not None or time.monotonic() > deadline:
                pytest.fail("Launcher did not create its child")
            time.sleep(0.02)
        if forced:
            parent.terminate()
        parent.wait(timeout=10)
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
    pid = int(child_pid.read_text())
    # tasklist is a local Windows process inventory; no sockets or shared user data.
    deadline = time.monotonic() + 5
    while True:
        inventory = subprocess.check_output(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], text=True
        )
        if f'"{pid}"' not in inventory:
            break
        assert time.monotonic() < deadline, "Windows Job Object left a child process running"
        time.sleep(0.05)
