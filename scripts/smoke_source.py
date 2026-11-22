"""Smoke-test a source ZIP in temporary paths with offline loopback requests only."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sqlite3
import subprocess
import tempfile
from contextlib import closing
from pathlib import Path
from zipfile import ZipFile

from smoke_application import application, check_first_run, user_environment


def run(source: Path, environment: dict[str, str], *command: str) -> None:
    subprocess.run(list(command), cwd=source, env=environment, check=True, timeout=600)


def source_environment(source: Path, home: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment.pop("FOLIO_J_DATABASE_PATH", None)
    environment.update(
        **user_environment(home),
        UV_PROJECT_ENVIRONMENT=str(source / "backend/.venv"),
        PYTHONIOENCODING="utf-8",
    )
    return environment


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
        database = root / "原始数据 data" / "app.db"
        environment = source_environment(source, root / "临时用户 home")
        python = Path(environment["UV_PROJECT_ENVIRONMENT"]) / (
            "Scripts/python.exe" if os.name == "nt" else "bin/python"
        )
        launcher = [str(python), "-m", "app.launcher"]
        # Reserve a free loopback port, then release it immediately before startup.
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        (source / "config/app.toml").write_text(
            f"[server]\nport = {port}\n", encoding="utf-8"
        )
        run(source, environment, "just", "setup")
        run(source, environment, "just", "build")
        check_first_run(
            launcher, source, environment, port, root / "首次选库 first library"
        )
        environment["FOLIO_J_DATABASE_PATH"] = str(database)
        run(source, environment, "just", "migrate")
        with application(launcher, source, environment, port) as client:
            client.frontend()
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
        with application(launcher, source, environment, port) as client:
            client.frontend()
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
