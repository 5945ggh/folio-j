"""Keep backend tests offline and separate from the user's configuration and data."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from support_network import install_network_guard

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


@pytest.fixture(autouse=True)
def block_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    install_network_guard(monkeypatch.setattr)
    yield
