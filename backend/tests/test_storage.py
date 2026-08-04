from pathlib import Path

import pytest

from app.services.storage import LocalDiskStorage, StorageKeyNotFoundError


def test_save_then_read_returns_same_bytes(tmp_path: Path) -> None:
    storage = LocalDiskStorage(tmp_path)

    storage.save("docs/a.txt", b"hello world")

    assert storage.read("docs/a.txt") == b"hello world"


def test_read_missing_key_raises(tmp_path: Path) -> None:
    storage = LocalDiskStorage(tmp_path)

    with pytest.raises(StorageKeyNotFoundError):
        storage.read("does/not/exist.txt")


def test_delete_then_read_raises(tmp_path: Path) -> None:
    storage = LocalDiskStorage(tmp_path)
    storage.save("docs/b.txt", b"bye")

    storage.delete("docs/b.txt")

    with pytest.raises(StorageKeyNotFoundError):
        storage.read("docs/b.txt")
