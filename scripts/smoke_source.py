"""Smoke-test a source ZIP in temporary paths with offline loopback requests only."""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import closing
from pathlib import Path
from zipfile import ZipFile


def run(source: Path, environment: dict[str, str], *command: str) -> None:
    subprocess.run(list(command), cwd=source, env=environment, check=True, timeout=600)


def check_application(source: Path, environment: dict[str, str], port: int) -> None:
    """Exercise the actual launcher and its shutdown, without any model settings."""
    python = (
        source
        / "backend/.venv"
        / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    )
    launcher = subprocess.Popen(
        [str(python), "scripts/run.py", "start"],
        cwd=source,
        env=environment,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        start_new_session=os.name == "posix",
    )
    # Ignore proxies even if the runner has global HTTP proxy configuration.
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    origin = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 40
        while True:
            if launcher.poll() is not None:
                raise RuntimeError(
                    f"Application exited before readiness: {launcher.returncode}"
                )
            try:
                with client.open(f"{origin}/api/health", timeout=1) as response:
                    if response.status == 200:
                        break
            except (urllib.error.URLError, TimeoutError):
                if time.monotonic() >= deadline:
                    raise RuntimeError("Application did not become healthy") from None
                time.sleep(0.2)
        with client.open(origin, timeout=5) as response:
            if b"<html" not in response.read():
                raise RuntimeError("Built frontend was not served")
    finally:
        if launcher.poll() is None:
            if os.name == "nt":
                launcher.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                os.killpg(launcher.pid, signal.SIGINT)
            try:
                launcher.wait(timeout=15)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    launcher.kill()
                else:
                    os.killpg(launcher.pid, signal.SIGKILL)
                launcher.wait(timeout=5)
                raise RuntimeError("Launcher did not stop after interrupt") from None
        if launcher.returncode != 0:
            raise RuntimeError(f"Launcher shutdown failed: {launcher.returncode}")
    try:
        client.open(f"{origin}/api/health", timeout=1).close()
    except (urllib.error.URLError, TimeoutError):
        pass
    else:
        raise RuntimeError("Application still responds after launcher shutdown")


def smoke(archive: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="Folio-J source smoke ") as temporary:
        root = Path(temporary)
        with ZipFile(archive) as package:
            package.extractall(root / "源码 source")
        directories = list((root / "源码 source").iterdir())
        if len(directories) != 1 or not directories[0].is_dir():
            raise ValueError("Expected one top-level source directory")
        source = directories[0]
        if (source / ".git").exists():
            raise ValueError("Source smoke must not rely on a Git checkout")
        home = root / "临时用户 home"
        home.mkdir()
        database = root / "原始数据 data" / "app.db"
        environment = os.environ.copy()
        environment.update(
            HOME=str(home),
            USERPROFILE=str(home),
            FOLIO_J_DATABASE_PATH=str(database),
            PYTHONIOENCODING="utf-8",
        )
        # Reserve a free loopback port, then release it immediately before startup.
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        (source / "config/app.toml").write_text(
            f"[server]\nport = {port}\n", encoding="utf-8"
        )
        run(source, environment, "just", "setup")
        run(source, environment, "just", "build")
        run(source, environment, "just", "migrate")
        check_application(source, environment, port)
        # Existing schema data, rather than merely an empty-file round trip.
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute(
                "INSERT INTO learner_profile VALUES (1, ?, ?, ?)",
                ("中文", "中文", "Windows source smoke 日本語"),
            )
        backup = root / "备份 with spaces & $literal"
        restored = root / "恢复 with spaces & $literal"
        run(source, environment, "just", "backup", str(backup))
        run(source, environment, "just", "restore", str(backup), str(restored))
        for arguments in [
            ("backup", str(backup)),
            ("restore", str(backup), str(restored)),
        ]:
            print(
                f"Expect existing destination refusal: just {arguments[0]}", flush=True
            )
            rejected = subprocess.run(
                ["just", *arguments],
                cwd=source,
                env=environment,
                check=False,
                timeout=600,
            )
            if rejected.returncode == 0:
                raise RuntimeError("Existing destination was accepted")
        with closing(sqlite3.connect(restored / "app.db")) as connection:
            row = connection.execute(
                "SELECT level_note FROM learner_profile WHERE id=1"
            ).fetchone()
            if row != ("Windows source smoke 日本語",):
                raise RuntimeError("Restored data did not match")
        environment["FOLIO_J_DATABASE_PATH"] = str(restored / "app.db")
        check_application(source, environment, port)
        print(
            json.dumps(
                {"source_smoke": "passed", "archive": str(archive)}, ensure_ascii=False
            )
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    smoke(parser.parse_args().archive.resolve())


if __name__ == "__main__":
    main()
