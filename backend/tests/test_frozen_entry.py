"""Keep failed interactive launches visible without blocking redirected CLI use."""

import importlib.util
import io
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest


def load_entry() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "frozen_entry", Path(__file__).resolve().parents[2] / "scripts/frozen/entry.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Console(io.StringIO):
    def isatty(self) -> bool:
        return True


@pytest.mark.parametrize("code", [0, 1, 2])
@pytest.mark.parametrize("piped", ["none", "stdin", "stdout", "missing"])
def test_pause_only_on_interactive_failure(
    code: int, piped: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry = load_entry()
    monkeypatch.setattr(entry, "main", lambda: code)
    monkeypatch.setattr(
        sys,
        "stdin",
        None if piped == "missing" else io.StringIO() if piped == "stdin" else Console(),
    )
    monkeypatch.setattr(sys, "stdout", io.StringIO() if piped == "stdout" else Console())
    prompts: list[str] = []

    def read(prompt: str) -> str:
        prompts.append(prompt)
        return ""

    monkeypatch.setattr("builtins.input", read)
    assert entry.run() == code
    assert bool(prompts) == (code != 0 and piped == "none")


@pytest.mark.parametrize("code", [0, 2, "argument error"])
def test_argparse_system_exit_keeps_original_code(
    code: int | str, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry = load_entry()

    def main() -> int:
        raise SystemExit(code)

    monkeypatch.setattr(entry, "main", main)
    monkeypatch.setattr(sys, "stdin", Console())
    monkeypatch.setattr(sys, "stdout", Console())
    prompts: list[str] = []

    def read(prompt: str) -> str:
        prompts.append(prompt)
        return ""

    monkeypatch.setattr("builtins.input", read)
    with pytest.raises(SystemExit) as stopped:
        entry.run()
    assert stopped.value.code == code
    assert bool(prompts) == (code != 0)


@pytest.mark.parametrize("interruption", [EOFError, KeyboardInterrupt])
def test_interrupted_pause_keeps_failure_code(
    interruption: type[BaseException], monkeypatch: pytest.MonkeyPatch
) -> None:
    entry = load_entry()
    monkeypatch.setattr(entry, "main", lambda: 1)
    monkeypatch.setattr(sys, "stdin", Console())
    monkeypatch.setattr(sys, "stdout", Console())

    def interrupted(prompt: str) -> str:
        raise interruption

    monkeypatch.setattr("builtins.input", interrupted)
    assert entry.run() == 1


def test_unexpected_exception_prints_traceback_once_before_pause_and_exits_nonzero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = load_entry()
    errors = io.StringIO()
    monkeypatch.setattr(sys, "stdin", Console())
    monkeypatch.setattr(sys, "stdout", Console())
    monkeypatch.setattr(sys, "stderr", errors)

    def main() -> int:
        raise RuntimeError("unexpected startup failure")

    def read(prompt: str) -> str:
        assert "RuntimeError: unexpected startup failure" in errors.getvalue()
        return ""

    monkeypatch.setattr(entry, "main", main)
    monkeypatch.setattr("builtins.input", read)
    assert entry.run() == 1
    assert errors.getvalue().count("RuntimeError: unexpected startup failure") == 1


def test_redirected_entry_argument_failure_exits_without_waiting(tmp_path: Path) -> None:
    entry = Path(__file__).resolve().parents[2] / "scripts/frozen/entry.py"
    completed = subprocess.run(
        [sys.executable, str(entry), "--unknown-argument"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert completed.returncode == 2
    assert "unrecognized arguments" in completed.stderr
    assert "按回车" not in completed.stdout
