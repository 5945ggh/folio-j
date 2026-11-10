"""Exercise a relocated frozen directory package offline with isolated user data.

Run with the development Python: python scripts/smoke_frozen.py dist/Folio-J.
Only the smoke controller needs Python; the application gets an empty PATH and
runs outside the checkout. All HTTP requests target loopback and ignore proxies.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Generator
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

REPOSITORY = Path(__file__).resolve().parents[1]
SYNTHETIC_MODEL = "frozen-smoke-model"
SYNTHETIC_OUTPUT = "冻结包 SDK 合成响应"
MANUAL_TEXT = "## 冻结包手写讲解\n日本語と中文を保存する。\n"


def executable(package: Path) -> Path:
    """Accept a directory package or its explicit executable, never a source tree."""
    candidate = package / ("Folio-J.exe" if os.name == "nt" else "Folio-J")
    if package.is_file():
        candidate = package
    if not candidate.is_file() or not (candidate.parent / "_internal").is_dir():
        raise ValueError(
            f"Expected a frozen directory package with _internal: {package}"
        )
    return candidate.resolve()


def check_resources(package: Path, repository: Path = REPOSITORY) -> None:
    """Catch omissions even in templates not reached by this offline workflow."""
    resource_root = package / "_internal"
    for source_directory in (
        "backend/prompts",
        "backend/alembic",
        "backend/static/startup",
    ):
        sources = [
            path
            for path in (repository / source_directory).rglob("*")
            if path.is_file() and "__pycache__" not in path.parts
        ]
        if not sources:
            raise RuntimeError(f"No smoke resource reference files: {source_directory}")
        for source in sources:
            relative = source.relative_to(repository)
            bundled = resource_root / relative
            if not bundled.is_file() or bundled.read_bytes() != source.read_bytes():
                raise RuntimeError(f"Missing or stale frozen resource: {relative}")
            if source.suffix == ".json":
                json.loads(bundled.read_bytes())
    if not (resource_root / "RELEASE.json").is_file():
        raise RuntimeError("Missing frozen RELEASE.json")


def isolated_environment(root: Path, database: Path) -> dict[str, str]:
    # Whitelist OS essentials; never inherit Python/Node paths, credentials,
    # application overrides, proxy settings or the runner's real user directory.
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"}
    }
    home = root / "临时用户 home"
    temp = root / "临时文件 temp"
    empty_path = root / "无运行时 empty PATH"
    for path in (home, temp, empty_path):
        path.mkdir(exist_ok=True)
    environment.update(
        HOME=str(home),
        USERPROFILE=str(home),
        APPDATA=str(home / "AppData/Roaming"),
        LOCALAPPDATA=str(home / "AppData/Local"),
        TMPDIR=str(temp),
        TMP=str(temp),
        TEMP=str(temp),
        PATH=str(empty_path),
        FOLIO_J_DATABASE_PATH=str(database),
    )
    return environment


def command(
    binary: Path,
    cwd: Path,
    environment: dict[str, str],
    *arguments: str,
    reject: bool = False,
) -> str:
    result = subprocess.run(
        [str(binary), *arguments],
        cwd=cwd,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
        timeout=120,
        check=False,
    )
    if (result.returncode == 0) == reject:
        raise RuntimeError(
            f"Unexpected exit {result.returncode}: {arguments}\n{result.stdout}\n{result.stderr}"
        )
    return result.stdout


def check_data_path(output: str, database: Path) -> None:
    """Match the settings' canonical path without allowing data-path to create it."""
    prefix = "下次迁移和启动使用的数据库："
    reported = [
        line.removeprefix(prefix)
        for line in output.splitlines()
        if line.startswith(prefix)
    ]
    # Settings resolves paths, including Windows' short user-directory aliases.
    expected = str(database.resolve())
    if reported != [expected] or database.exists():
        raise RuntimeError(
            "data-path selected the wrong database or created it\n"
            f"Expected: {expected}\nReported: {reported!r}"
        )


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
        raw: bytes | None = None,
        content_type: str = "application/json",
    ) -> Any:
        body = (
            json.dumps(data, ensure_ascii=False).encode() if data is not None else raw
        )
        request = urllib.request.Request(
            self.origin + path, data=body, headers={"Content-Type": content_type}
        )
        try:
            with self.opener.open(request, timeout=90) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"{request.method} {path}: {exc.code} {exc.read()!r}"
            ) from exc

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
    binary: Path, cwd: Path, environment: dict[str, str], port: int
) -> Generator[Client, None, None]:
    client = Client(port)
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(
            [str(binary), "start", "--no-browser"],
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
                    raise RuntimeError(
                        f"Application exited before readiness: {process.returncode}"
                    )
                try:
                    client.json("/api/health")
                    break
                except (urllib.error.URLError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError(
                            "Application did not become healthy"
                        ) from None
                    time.sleep(0.2)
            client.frontend()
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
                    raise RuntimeError(
                        "Frozen application did not stop after interrupt"
                    ) from None
            if process.returncode != 0:
                log.seek(0)
                raise RuntimeError(
                    f"Frozen application shutdown failed: {process.returncode}\n"
                    + log.read().decode("utf-8", errors="replace")
                )
    try:
        client.get("/api/health")
    except (urllib.error.URLError, TimeoutError):
        return
    raise RuntimeError("Application still responds after launcher shutdown")


class SyntheticProvider:
    """Only serve the exact loopback SDK requests used by this smoke."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def response(
        self, method: str, path: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.requests.append((method, path, payload))
        if (method, path) == ("GET", "/v1/models"):
            return {"object": "list", "data": [{"id": SYNTHETIC_MODEL}]}
        if (
            method != "POST"
            or path not in ("/v1/chat/completions", "/v1/responses")
            or payload.get("model") != SYNTHETIC_MODEL
            or payload.get("stream", False)
            or not payload.get("messages" if path.endswith("completions") else "input")
        ):
            raise ValueError(f"Unexpected synthetic provider request: {method} {path}")
        # Same successful protocol fixtures as test_settings_adapters.py.
        if path.endswith("completions"):
            return {
                "id": "chat_smoke",
                "object": "chat.completion",
                "created": 1,
                "model": SYNTHETIC_MODEL,
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": SYNTHETIC_OUTPUT},
                    }
                ],
                "usage": {
                    "prompt_tokens": 3,
                    "completion_tokens": 2,
                    "total_tokens": 5,
                },
            }
        return {
            "id": "resp_smoke",
            "object": "response",
            "created_at": 1,
            "model": SYNTHETIC_MODEL,
            "status": "completed",
            "output": [
                {
                    "id": "msg_smoke",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {
                            "type": "output_text",
                            "text": SYNTHETIC_OUTPUT,
                            "annotations": [],
                        }
                    ],
                }
            ],
            "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
        }

    def check_requests(self) -> None:
        paths = [(method, path) for method, path, _ in self.requests]
        if paths != [
            ("GET", "/v1/models"),
            ("POST", "/v1/chat/completions"),
            ("GET", "/v1/models"),
            ("POST", "/v1/responses"),
        ]:
            raise RuntimeError(f"Unexpected SDK request history: {paths}")


@contextmanager
def synthetic_provider() -> Generator[tuple[str, SyntheticProvider], None, None]:
    provider = SyntheticProvider()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def handle_request(self) -> None:
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            try:
                result = provider.response(
                    self.command, self.path, json.loads(raw) if raw else {}
                )
                body = json.dumps(result, ensure_ascii=False).encode()
                self.send_response(200)
            except ValueError as exc:
                body = json.dumps({"error": str(exc)}).encode()
                self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = handle_request
        do_POST = handle_request

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/v1", provider
        finally:
            server.shutdown()
            thread.join(timeout=5)


def verify_sdk(client: Client) -> list[dict[str, Any]]:
    """Reach both real SDK adapters through deterministic local protocol fixtures."""
    runs: list[dict[str, Any]] = []
    with synthetic_provider() as (base_url, stub):
        for protocol in ("chat_completions", "responses"):
            provider = client.json(
                "/api/providers",
                {
                    "name": f"冻结合成 {protocol}",
                    "base_url": base_url,
                    "protocol": protocol,
                },
            )
            if provider["discovered_models"] != [SYNTHETIC_MODEL]:
                raise RuntimeError(f"Frozen SDK model discovery failed: {provider}")
            model = client.json(
                f"/api/providers/{provider['id']}/models",
                {
                    "model_id": SYNTHETIC_MODEL,
                },
            )
            accepted = client.json(
                f"/api/provider-models/{model['id']}/verifications",
                {
                    "stream": False,
                },
            )
            deadline = time.monotonic() + 30
            while True:
                run = client.json(f"/api/runs/{accepted['id']}")
                if run["status"] not in ("queued", "running"):
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"Frozen SDK verification timed out: {run}")
                time.sleep(0.1)
            if (
                run["status"] != "succeeded"
                or run["protocol"] != protocol
                or run["output_text"] != SYNTHETIC_OUTPUT
                or run["usage"]["total_tokens"] != 5
            ):
                raise RuntimeError(f"Frozen SDK verification failed: {run}")
            runs.append(run)
        stub.check_requests()
    return runs


def check_database_runs(database: Path, saved: dict[str, Any]) -> None:
    # /api/runs lists verification only; also reject any unexpected Run purpose
    # directly in the isolated database, including after backup restoration.
    expected = sorted(
        (run["id"], "verification", "succeeded", SYNTHETIC_OUTPUT)
        for run in saved["runs"]
    )
    with closing(sqlite3.connect(database)) as connection:
        actual = connection.execute(
            "SELECT id, purpose, status, output_text FROM runs ORDER BY id"
        ).fetchall()
        if actual != expected:
            raise RuntimeError(f"Unexpected persisted model Runs: {actual}")
        if connection.execute(
            "SELECT count(*) FROM runs WHERE raw_response IS NULL"
        ).fetchone() != (0,):
            raise RuntimeError("SDK Run raw protocol response was not persisted")


def dictionary_archive() -> bytes:
    """Use the same synthetic Yomitan record format as test_dictionary_store."""
    stream = io.BytesIO()
    with ZipFile(stream, "w", ZIP_DEFLATED) as package:
        package.writestr(
            "index.json",
            json.dumps({"title": "冻结合成词典", "format": 3, "revision": "smoke-1"}),
        )
        package.writestr(
            "term_bank_1.json",
            json.dumps([["雨", "アメ", "n", "", 0, ["冻结包合成释义"], 1, ""]]),
        )
    return stream.getvalue()


def seed(client: Client, fixture: bytes) -> dict[str, Any]:
    source = client.json("/api/sources", {"title": "冻结包 smoke 中文日本語"})
    material = client.json(
        f"/api/sources/{source['id']}/materials?filename=synthetic-reading.epub",
        raw=fixture,
        content_type="application/epub+zip",
    )["material"]
    material_id = material["id"]
    version_id = material["version_id"]
    prepared = client.json(
        f"/api/materials/{material_id}/readings/prepare", {"version_id": version_id}
    )
    if prepared["token_count"] <= 0:
        raise RuntimeError("Bundled Sudachi produced no tokens")
    chapter = material["chapters"][0]["id"]
    readings = client.json(
        f"/api/materials/{material_id}/readings?version_id={version_id}&chapter_id={chapter}"
    )
    tokens = [
        token for resource in readings["resources"] for token in resource["tokens"]
    ]
    if not tokens or not any(token["reading"] for token in tokens):
        raise RuntimeError("No readings returned from the bundled tokenizer")
    stats = client.json(
        f"/api/materials/{material_id}/statistics?version_id={version_id}"
    )
    if (
        stats["text"]["character_count"] <= 0
        or stats["lexical"]["counted_token_count"] <= 0
    ):
        raise RuntimeError("Material statistics are empty")
    segment = client.json(
        f"/api/sources/{source['id']}/segments", {"text": "雨が降っている。"}
    )
    prompt = client.json(f"/api/segments/{segment['id']}/explanation-prompt")["prompt"]
    if segment["text"] not in prompt:
        raise RuntimeError(
            "Bundled explanation templates did not render the target text"
        )
    analysis = client.json(
        f"/api/segments/{segment['id']}/analyses",
        {
            "request_id": str(uuid4()),
            "expected_text_sha256": segment["text_sha256"],
            "source_md": MANUAL_TEXT,
        },
    )
    dictionary = client.json(
        "/api/dictionary/library/import",
        raw=dictionary_archive(),
        content_type="application/zip",
    )
    saved: dict[str, Any] = {
        "material": material,
        "analysis": analysis,
        "dictionary": dictionary,
        "runs": [],
    }
    check_saved(client, saved)
    return saved


def check_saved(client: Client, saved: dict[str, Any]) -> None:
    material = saved["material"]
    current = client.json(f"/api/materials/{material['id']}")
    if current != material:
        raise RuntimeError("Material did not survive restart/restore")
    analysis = client.json(f"/api/analyses/{saved['analysis']['id']}")
    if analysis != saved["analysis"] or analysis["source_md"] != MANUAL_TEXT:
        raise RuntimeError("Manual explanation did not survive restart/restore")
    dictionary_id = saved["dictionary"]["dictionary_id"]
    lookup = client.json(
        "/api/dictionary/lookup",
        {"text": "雨", "expected_dictionary_id": dictionary_id},
    )
    if not lookup["matches"] or not all(
        match["dictionary_id"] == dictionary_id for match in lookup["matches"]
    ):
        raise RuntimeError(
            "Imported user dictionary is not usable after restart/restore"
        )
    actual = {run["id"]: run for run in client.json("/api/runs")}
    expected = {run["id"]: run for run in saved["runs"]}
    if actual != expected:
        raise RuntimeError(
            "Synthetic SDK Run history changed or unexpected Runs were created"
        )


def smoke(package: Path) -> None:
    original = executable(package)
    with tempfile.TemporaryDirectory(prefix="Folio-J frozen 中文 smoke ") as temporary:
        root = Path(temporary)
        copied = root / "复制产物 copied package"
        shutil.copytree(original.parent, copied, symlinks=True)
        relocated = root / "移位产物 relocated package"
        copied.rename(relocated)
        binary = relocated / original.name
        check_resources(relocated)
        cwd = root / "独立工作目录 unrelated cwd"
        cwd.mkdir()
        database = root / "原始数据 🗂 𠮷 original data" / "app.db"
        environment = isolated_environment(root, database)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port: int = listener.getsockname()[1]
        config = Path(environment["HOME"]) / "Folio-J-Data"
        config.mkdir()
        (config / "app.toml").write_text(f"[server]\nport = {port}\n", encoding="utf-8")
        check_data_path(command(binary, cwd, environment, "data-path"), database)
        command(binary, cwd, environment, "migrate")
        with closing(sqlite3.connect(database)) as connection:
            if not connection.execute(
                "SELECT version_num FROM alembic_version"
            ).fetchone():
                raise RuntimeError("Empty database was not migrated")
        fixture = (
            REPOSITORY / "backend/tests/fixtures/epub/synthetic-reading.epub"
        ).read_bytes()
        with application(binary, cwd, environment, port) as client:
            saved = seed(client, fixture)
            saved["runs"] = verify_sdk(client)
            check_saved(client, saved)
        check_database_runs(database, saved)
        # An ordinary restart protects the data before testing backup/restore.
        with application(binary, cwd, environment, port) as client:
            check_saved(client, saved)
        backup = root / "备份 🗂 𠮷 backup & $literal"
        restored = root / "恢复 🗂 𠮷 restored & $literal"
        command(binary, cwd, environment, "backup", str(backup))
        command(binary, cwd, environment, "restore", str(backup), str(restored))
        command(binary, cwd, environment, "backup", str(backup), reject=True)
        command(
            binary, cwd, environment, "restore", str(backup), str(restored), reject=True
        )
        # Remove the original data so a restore cannot accidentally read it.
        shutil.rmtree(database.parent)
        environment["FOLIO_J_DATABASE_PATH"] = str(restored / "app.db")
        with application(binary, cwd, environment, port) as client:
            check_saved(client, saved)
        check_database_runs(restored / "app.db", saved)
        print(
            json.dumps(
                {"frozen_smoke": "passed", "package": str(package)}, ensure_ascii=False
            )
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "package", type=Path, help="Directory package or executable path"
    )
    smoke(parser.parse_args().package.resolve())


if __name__ == "__main__":
    main()
