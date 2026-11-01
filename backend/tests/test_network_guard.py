import asyncio
import socket
import sys
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from typing import cast

import pytest
from support_network import install_network_guard

_STDLIB_SOCKETPAIR = cast(
    Callable[[], tuple[socket.socket, socket.socket]],
    getattr(socket, "_fallback_socketpair", socket.socketpair),
)


def test_network_guard_blocks_dns_and_socket_connect() -> None:
    with pytest.raises(RuntimeError, match="Network access is forbidden"):
        socket.getaddrinfo("example.invalid", 80)
    with socket.socket() as connection:
        with pytest.raises(RuntimeError, match="Network access is forbidden"):
            connection.connect(("192.0.2.1", 80))


@pytest.mark.parametrize("host", ["127.0.0.1", "192.0.2.1"])
def test_network_guard_blocks_direct_connections_including_loopback(host: str) -> None:
    with socket.socket() as connection:
        with pytest.raises(RuntimeError, match="Network access is forbidden"):
            connection.connect((host, 80))
        with pytest.raises(RuntimeError, match="Network access is forbidden"):
            connection.connect_ex((host, 80))
    with pytest.raises(RuntimeError, match="Network access is forbidden"):
        socket.create_connection((host, 80))


def _stdlib_socketpair() -> tuple[socket.socket, socket.socket]:
    # Newer CPython exposes its Windows fallback on every platform, allowing
    # this regression to exercise the TCP handshake on macOS/Linux too.
    return _STDLIB_SOCKETPAIR()


@pytest.mark.parametrize("fallback", [False, True])
def test_network_guard_allows_stdlib_socketpair(fallback: bool) -> None:
    reader, writer = _stdlib_socketpair() if fallback else socket.socketpair()
    with reader, writer:
        writer.sendall(b"local self pipe")
        assert reader.recv(64) == b"local self pipe"


@pytest.mark.parametrize("fallback", [False, True])
def test_network_guard_allows_new_event_loop(
    monkeypatch: pytest.MonkeyPatch, fallback: bool
) -> None:
    if fallback:
        monkeypatch.setattr(socket, "socketpair", _stdlib_socketpair)
    loop = asyncio.new_event_loop()
    try:
        assert loop.run_until_complete(asyncio.sleep(0, result="initialized")) == "initialized"
    finally:
        loop.close()


def test_socketpair_does_not_allow_another_threads_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not hasattr(socket, "_fallback_socketpair") and sys.platform != "win32":
        pytest.skip("This CPython exposes only its native socketpair; no TCP fallback to pause")
    entered = Event()
    release = Event()
    setblocking = socket.socket.setblocking

    def pause_handshake(connection: socket.socket, flag: bool) -> None:
        setblocking(connection, flag)
        if not flag:
            entered.set()
            assert release.wait(timeout=5), "socketpair test did not release its handshake"

    monkeypatch.setattr(socket.socket, "setblocking", pause_handshake)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(_stdlib_socketpair)
        try:
            assert entered.wait(timeout=5), "socketpair did not start its handshake"
            with socket.socket() as connection:
                with pytest.raises(RuntimeError, match="Network access is forbidden"):
                    connection.connect(("127.0.0.1", 80))
        finally:
            release.set()
        reader, writer = pending.result(timeout=5)
        reader.close()
        writer.close()


def test_socketpair_failure_keeps_direct_connections_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not hasattr(socket, "_fallback_socketpair") and sys.platform != "win32":
        pytest.skip("This CPython exposes only its native socketpair; no TCP fallback to interrupt")

    def fail_accept(_listener: socket.socket) -> tuple[socket.socket, object]:
        raise OSError("self-pipe handshake failure")

    monkeypatch.setattr(socket.socket, "accept", fail_accept)
    with pytest.raises(OSError, match="self-pipe handshake failure"):
        _stdlib_socketpair()
    with socket.socket() as connection:
        with pytest.raises(RuntimeError, match="Network access is forbidden"):
            connection.connect(("127.0.0.1", 80))


def test_network_guard_callback_and_scope_cleanup() -> None:
    attempts: list[str] = []
    previous_connect = socket.socket.connect
    with pytest.MonkeyPatch.context() as patch:
        install_network_guard(patch.setattr, on_denied=lambda: attempts.append("denied"))
        with socket.socket() as connection:
            with pytest.raises(RuntimeError, match="Network access is forbidden"):
                connection.connect(("127.0.0.1", 80))
        reader, writer = _stdlib_socketpair()
        reader.close()
        writer.close()
        assert attempts == ["denied"]
    assert socket.socket.connect is previous_connect
    with socket.socket() as connection:
        with pytest.raises(RuntimeError, match="Network access is forbidden"):
            connection.connect(("127.0.0.1", 80))
