from pathlib import Path
from typing import Protocol


class StorageKeyNotFoundError(Exception):
    pass


class StorageAdapter(Protocol):
    def save(self, key: str, data: bytes) -> None: ...
    def read(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...


class LocalDiskStorage:
    """StorageAdapter backed by a local directory. Other implementations
    (e.g. S3) conform to the same Protocol - callers depend on
    StorageAdapter, never on LocalDiskStorage directly."""

    def __init__(self, base_dir: Path) -> None:
        self._base_dir = base_dir

    def save(self, key: str, data: bytes) -> None:
        path = self._path_for(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def read(self, key: str) -> bytes:
        path = self._path_for(key)
        if not path.is_file():
            raise StorageKeyNotFoundError(key)
        return path.read_bytes()

    def delete(self, key: str) -> None:
        path = self._path_for(key)
        if not path.is_file():
            raise StorageKeyNotFoundError(key)
        path.unlink()

    def _path_for(self, key: str) -> Path:
        return self._base_dir / key
