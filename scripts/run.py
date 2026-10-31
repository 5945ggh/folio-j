"""Run the local development pair or the built application."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import FrameType
from typing import NoReturn

from app.config import load_settings

ROOT = Path(__file__).resolve().parents[1]


def request_stop(_signum: int, _frame: FrameType | None) -> NoReturn:
    raise KeyboardInterrupt


def stop_processes(processes: list[subprocess.Popen[bytes]]) -> None:
    """Stop only child process groups created by this launcher."""
    for process in processes:
        if process.poll() is None:
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            else:
                process.terminate()
    for process in processes:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            process.wait()


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"dev", "start"}:
        print("Usage: run.py dev|start", file=sys.stderr)
        return 2

    settings = load_settings()
    signal.signal(signal.SIGTERM, request_stop)
    mode = sys.argv[1]
    if mode == "start" and not (ROOT / "frontend/dist/index.html").is_file():
        print(
            "缺少前端构建，请先执行 pnpm --dir frontend build（或 just build）。",
            file=sys.stderr,
        )
        return 1

    api_url = f"http://{settings.server.host}:{settings.server.port}"
    access_url = (
        f"http://{settings.server.host}:{settings.server.dev_port}"
        if mode == "dev"
        else api_url
    )
    print(f"数据库：{settings.database.path.resolve()}", flush=True)
    print(f"启动访问地址：{access_url}", flush=True)
    if mode == "dev":
        print(f"API 文档：{api_url}/api/docs", flush=True)
    port_fields = "port（应用）或 dev_port（开发页面）" if mode == "dev" else "port"
    print(
        f"若提示端口被占用，请修改 app.toml 的 [server].{port_fields} 后重启。",
        flush=True,
    )

    command = [
        sys.executable,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        settings.server.host,
        "--port",
        str(settings.server.port),
    ]
    if mode == "dev":
        command.extend(["--reload", "--reload-dir", str(ROOT / "backend/src")])

    processes: list[subprocess.Popen[bytes]] = []
    try:
        processes.append(subprocess.Popen(command, cwd=ROOT, start_new_session=True))
        if mode == "dev":
            environment = os.environ.copy()
            environment["FOLIO_API_TARGET"] = api_url
            environment["FOLIO_DEV_PORT"] = str(settings.server.dev_port)
            processes.append(
                subprocess.Popen(
                    ["pnpm", "--dir", "frontend", "dev"],
                    cwd=ROOT,
                    env=environment,
                    start_new_session=True,
                )
            )
        while True:
            for process in processes:
                result = process.poll()
                if result is not None:
                    return result
            time.sleep(0.2)
    except KeyboardInterrupt:
        return 0
    finally:
        stop_processes(processes)


if __name__ == "__main__":
    raise SystemExit(main())
