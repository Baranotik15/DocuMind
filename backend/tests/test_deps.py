from pathlib import Path

import pytest

from app.config import Settings
from app.documents import deps
from app.documents.storage import LocalDiskStorage, StorageKeyNotFoundError


def test_get_storage_returns_local_disk_storage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage_dir = tmp_path / "documents"
    monkeypatch.setattr(
        deps, "get_settings", lambda: Settings(storage_base_dir=str(storage_dir))
    )

    storage = deps.get_storage()

    assert isinstance(storage, LocalDiskStorage)
    assert hasattr(storage, "save") and hasattr(storage, "read") and hasattr(storage, "delete")


def test_get_storage_creates_base_dir_if_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage_dir = tmp_path / "does" / "not" / "exist" / "yet"
    assert not storage_dir.exists()
    monkeypatch.setattr(
        deps, "get_settings", lambda: Settings(storage_base_dir=str(storage_dir))
    )

    deps.get_storage()

    assert storage_dir.is_dir()


def test_get_storage_save_read_delete_round_trip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage_dir = tmp_path / "documents"
    monkeypatch.setattr(
        deps, "get_settings", lambda: Settings(storage_base_dir=str(storage_dir))
    )

    storage = deps.get_storage()
    storage.save("docs/a.txt", b"hello world")

    assert storage.read("docs/a.txt") == b"hello world"

    storage.delete("docs/a.txt")

    with pytest.raises(StorageKeyNotFoundError):
        storage.read("docs/a.txt")
