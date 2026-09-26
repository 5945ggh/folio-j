"""Keep the backend test suite offline, including accidental client calls."""

import socket
from collections.abc import Iterator
from typing import NoReturn

import pytest


def _deny_network(*_args: object, **_kwargs: object) -> NoReturn:
    raise RuntimeError("Network access is forbidden in backend tests")


@pytest.fixture(autouse=True)
def block_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(socket.socket, "connect", _deny_network)
    monkeypatch.setattr(socket.socket, "connect_ex", _deny_network)
    monkeypatch.setattr(socket, "create_connection", _deny_network)
    monkeypatch.setattr(socket, "getaddrinfo", _deny_network)
    yield
