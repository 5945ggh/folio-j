"""Keep backend tests offline and separate from the user's configuration and data."""

import socket
from collections.abc import Iterator
from pathlib import Path
from typing import NoReturn

import pytest

from app import config as app_config


@pytest.fixture(autouse=True)
def isolate_user_settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    # Windows expanduser uses USERPROFILE rather than HOME.
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    assert Path.home() == tmp_path
    monkeypatch.delenv("FOLIO_J_DATABASE_PATH", raising=False)
    # Also isolate installation config and legacy data/app.db selection.
    monkeypatch.setattr(app_config, "REPO_ROOT", tmp_path / "installation")


def _deny_network(*_args: object, **_kwargs: object) -> NoReturn:
    raise RuntimeError("Network access is forbidden in backend tests")


@pytest.fixture(autouse=True)
def block_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(socket.socket, "connect", _deny_network)
    monkeypatch.setattr(socket.socket, "connect_ex", _deny_network)
    monkeypatch.setattr(socket, "create_connection", _deny_network)
    monkeypatch.setattr(socket, "getaddrinfo", _deny_network)
    yield
