"""Run the local development pair or the built application."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from importlib import import_module
from pathlib import Path
from types import FrameType
from typing import NoReturn, cast

from app.config import load_settings

ROOT = Path(__file__).resolve().parents[1]


def request_stop(_signum: int, _frame: FrameType | None) -> NoReturn:
    raise KeyboardInterrupt


def stop_processes(
    processes: list[subprocess.Popen[bytes]],
    *,
    application: subprocess.Popen[bytes] | None = None,
) -> None:
    """Stop only child process groups created by this launcher."""
    for process in processes:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            try:
                process.send_signal(signal.CTRL_BREAK_EVENT)
            except OSError:
                process.terminate()
    for process in processes:
        try:
            # The application holds its database lock until lifespan cleanup ends.
            # It may need longer than the frontend's bounded shutdown grace period.
            process.wait(
                timeout=None if os.name == "nt" and process is application else 5
            )
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            process.wait()


def spawn_process(
    command: list[str], environment: dict[str, str] | None = None
) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        command,
        cwd=ROOT,
        env=environment,
        start_new_session=os.name == "posix",
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )


def frontend_command() -> list[str]:
    """Call Vite through Node directly, without invoking a Windows .cmd shim."""
    node = shutil.which("node")
    if node is None:
        raise FileNotFoundError("缺少 Node.js，请先安装并加入 PATH。")
    return [
        node,
        str(ROOT / "frontend/node_modules/vite/bin/vite.js"),
        str(ROOT / "frontend"),
        "--host",
        "127.0.0.1",
    ]


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"dev", "start"}:
        print("Usage: run.py dev|start", file=sys.stderr)
        return 2

    settings = load_settings()
    signal.signal(signal.SIGTERM, request_stop)
    if os.name == "nt":
        contain_process_tree = cast(
            Callable[[], None], import_module("windows_process").contain_process_tree
        )

        signal.signal(signal.SIGBREAK, request_stop)
        contain_process_tree()
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
        if os.name == "nt":
            command = [sys.executable, str(ROOT / "scripts/windows_reload.py")]
        else:
            command.extend(["--reload", "--reload-dir", str(ROOT / "backend/src")])

    processes: list[subprocess.Popen[bytes]] = []
    application: subprocess.Popen[bytes] | None = None
    try:
        application = spawn_process(command)
        processes.append(application)
        if mode == "dev":
            environment = os.environ.copy()
            environment["FOLIO_API_TARGET"] = api_url
            environment["FOLIO_DEV_PORT"] = str(settings.server.dev_port)
            processes.append(spawn_process(frontend_command(), environment))
        while True:
            for process in processes:
                result = process.poll()
                if result is not None:
                    return result
            time.sleep(0.2)
    except KeyboardInterrupt:
        return 0
    except OSError as error:
        print(f"无法启动：{error}", file=sys.stderr)
        return 1
    finally:
        # A second Ctrl-C must not interrupt cleanup and leave child services alive.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if os.name == "nt":
            signal.signal(signal.SIGBREAK, signal.SIG_IGN)
        stop_processes(processes, application=application)


if __name__ == "__main__":
    raise SystemExit(main())
