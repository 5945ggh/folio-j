"""Shared loopback checks for the source and frozen package launchers."""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any


def user_environment(home: Path) -> dict[str, str]:
    home.mkdir()
    return {
        "HOME": str(home),
        "USERPROFILE": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "APPDATA": str(home / "AppData/Roaming"),
        "LOCALAPPDATA": str(home / "AppData/Local"),
    }


class Client:
    def __init__(self, port: int) -> None:
        self.origin = f"http://127.0.0.1:{port}"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(self, path: str) -> bytes:
        with self.opener.open(self.origin + path, timeout=60) as response:
            return response.read()

    def json(
        self,
        path: str,
        data: object = None,
        *,
        headers: dict[str, str] | None = None,
        raw: bytes | None = None,
        content_type: str = "application/json",
    ) -> Any:
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else raw
        request = urllib.request.Request(
            self.origin + path,
            data=body,
            headers={"Content-Type": content_type, **(headers or {})},
        )
        try:
            with self.opener.open(request, timeout=90) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"{request.method} {path}: {exc.code} {exc.read()!r}") from exc

    def frontend(self) -> None:
        html = self.get("/")
        if b"<html" not in html or self.get("/settings") != html:
            raise RuntimeError("Built SPA and history fallback were not served")
        assets = re.findall(rb'(?:src|href)="([^"?#]+\.(?:js|css))"', html)
        if not any(path.endswith(b".js") for path in assets) or not any(
            path.endswith(b".css") for path in assets
        ):
            raise RuntimeError("Built frontend does not reference both JS and CSS")
        for asset in assets:
            path = asset.decode()
            if not path.startswith("/") or path.startswith("//"):
                raise RuntimeError(f"Frontend asset is not local: {path}")
            body = self.get(path)
            if not body or b"<html" in body[:100].lower():
                raise RuntimeError(f"Missing frontend asset: {path}")


@contextmanager
def application(
    launcher: list[str],
    cwd: Path,
    environment: dict[str, str],
    port: int,
    *,
    selecting: bool = False,
) -> Generator[Client, None, None]:
    client = Client(port)
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(
            [*launcher, "start", "--no-browser"],
            cwd=cwd,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
            start_new_session=os.name == "posix",
        )
        try:
            deadline = time.monotonic() + 60
            while True:
                if process.poll() is not None:
                    raise RuntimeError(f"Application exited before readiness: {process.returncode}")
                try:
                    client.json("/_startup/state" if selecting else "/api/health")
                    break
                except (urllib.error.URLError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Application did not become healthy") from None
                    time.sleep(0.2)
            yield client
        except BaseException:
            log.seek(0)
            print(log.read().decode("utf-8", errors="replace"), flush=True)
            raise
        finally:
            if process.poll() is None:
                if os.name == "nt":
                    process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    os.killpg(process.pid, signal.SIGINT)
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    if os.name == "nt":
                        process.kill()
                    else:
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
                    raise RuntimeError("Application did not stop after interrupt") from None
            if process.returncode != 0:
                log.seek(0)
                raise RuntimeError(
                    f"Application shutdown failed: {process.returncode}\n"
                    + log.read().decode("utf-8", errors="replace")
                )
    try:
        client.get("/_startup/state")
    except (urllib.error.URLError, TimeoutError):
        return
    raise RuntimeError("Application still responds after launcher shutdown")


def check_first_run(
    launcher: list[str],
    cwd: Path,
    environment: dict[str, str],
    port: int,
    directory: Path,
) -> None:
    if "FOLIO_J_DATABASE_PATH" in environment:
        raise ValueError("First-run smoke must not launch with a database override")
    database = (directory / "app.db").resolve()
    default_database = Path(environment["HOME"]) / "Folio-J-Data/app.db"
    with application(launcher, cwd, environment, port, selecting=True) as client:
        state = client.json("/_startup/state")
        if state["ready"] or state["recovery"] or state["selected_path"] is not None:
            raise RuntimeError(f"Expected first-run selection: {state}")
        if database.exists() or default_database.exists():
            raise RuntimeError("A learning database already exists before selection")
        token = re.search(rb'<script nonce="([^"]+)"', client.get("/"))
        if token is None:
            raise RuntimeError("No startup token in the selection page")
        state = client.json(
            "/_startup/select",
            {"directory": str(directory), "mode": "new"},
            headers={
                "Origin": client.origin,
                "X-Folio-Startup-Token": token[1].decode(),
            },
        )
        if not state["ready"] or state["selected_path"] != str(database) or not database.is_file():
            raise RuntimeError(f"Selection did not create the chosen database: {state}")
        source = client.json("/api/sources", {"title": "首次选库 smoke"})
    with application(launcher, cwd, environment, port) as client:
        state = client.json("/_startup/state")
        if not state["ready"] or state["selected_path"] != str(database):
            raise RuntimeError(f"Restart did not remember the chosen database: {state}")
        if client.json(f"/api/sources/{source['id']}") != source:
            raise RuntimeError("Restart did not retain the chosen library's data")
