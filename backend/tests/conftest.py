"""Keep the backend test suite offline, including accidental client calls."""

import socket
from collections.abc import Iterator
from pathlib import Path
from typing import NoReturn

import pytest


@pytest.fixture(autouse=True)
def isolate_user_settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))


def _deny_network(*_args: object, **_kwargs: object) -> NoReturn:
    raise RuntimeError("Network access is forbidden in backend tests")


@pytest.fixture(autouse=True)
def block_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(socket.socket, "connect", _deny_network)
    monkeypatch.setattr(socket.socket, "connect_ex", _deny_network)
    monkeypatch.setattr(socket, "create_connection", _deny_network)
    monkeypatch.setattr(socket, "getaddrinfo", _deny_network)
    yield
