"""Entry point for the self-contained, browser-based distribution."""

import sys
import traceback


def main() -> int:
    # Import inside the guarded entry so missing bundle dependencies remain visible.
    from app.launcher import main as launcher_main

    return launcher_main()


def _pause_on_failure(code: object) -> None:
    if code in (None, 0) or sys.stdin is None or sys.stdout is None:
        return
    try:
        interactive = sys.stdin.isatty() and sys.stdout.isatty()
    except (OSError, ValueError):
        return
    if interactive:
        try:
            input("\n启动失败。按回车关闭窗口…")
        except (EOFError, KeyboardInterrupt, OSError):
            pass


def run() -> int:
    try:
        result = main()
    except SystemExit as exc:
        _pause_on_failure(exc.code)
        raise
    except Exception:  # noqa: BLE001 - Final process boundary must preserve unexpected diagnostics.
        # Show unexpected failures before waiting and return a failing status
        # without letting the interpreter print the same traceback a second time.
        traceback.print_exc()
        _pause_on_failure(1)
        return 1
    _pause_on_failure(result)
    return result


if __name__ == "__main__":
    raise SystemExit(run())
