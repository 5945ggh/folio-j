"""Deny test network access while allowing CPython's private socketpair handshake."""

import inspect
import socket
from collections.abc import Callable
from types import CodeType, FrameType
from typing import NoReturn, cast

_SOCKET_CONNECT = socket.socket.connect
# Older CPython defines the Windows implementation directly as socketpair;
# newer releases also expose it as _fallback_socketpair on other platforms.
_SOCKETPAIR_CODES = tuple(
    code
    for name in ("socketpair", "_fallback_socketpair")
    if isinstance(code := getattr(getattr(socket, name, None), "__code__", None), CodeType)
)


def _is_socketpair_handshake(caller: FrameType, connection: socket.socket, address: object) -> bool:
    if not any(caller.f_code is code for code in _SOCKETPAIR_CODES):
        return False
    if caller.f_locals.get("csock") is not connection:
        return False
    listener = caller.f_locals.get("lsock")
    if not isinstance(listener, socket.socket) or listener.family not in (
        socket.AF_INET,
        socket.AF_INET6,
    ):
        return False
    endpoint = cast(tuple[str, int], listener.getsockname()[:2])
    return address == endpoint and endpoint[0] in ("127.0.0.1", "::1") and endpoint[1] > 0


def install_network_guard(
    patch: Callable[[object, str, object], None] = setattr,
    *,
    on_denied: Callable[[], None] | None = None,
) -> None:
    """Install permanently, or use monkeypatch.setattr for fixture-scoped cleanup."""

    def deny_network(*_args: object, **_kwargs: object) -> NoReturn:
        if on_denied is not None:
            on_denied()
        raise RuntimeError("Network access is forbidden in backend tests")

    def guarded_connect(connection: socket.socket, address: object) -> None:
        # Identify the exact stdlib call and socket, rather than temporarily
        # allowing loopback connections or relaxing the guard in another thread.
        current_frame = inspect.currentframe()
        try:
            allowed = (
                current_frame is not None
                and current_frame.f_back is not None
                and _is_socketpair_handshake(current_frame.f_back, connection, address)
            )
        finally:
            del current_frame
        if allowed:
            _SOCKET_CONNECT(connection, cast(tuple[str, int], address))
            return
        deny_network()

    patch(socket.socket, "connect", guarded_connect)
    patch(socket.socket, "connect_ex", deny_network)
    patch(socket, "create_connection", deny_network)
    patch(socket, "getaddrinfo", deny_network)
