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
        """Resolves `key` to an absolute path and verifies it stays under
        base_dir - defense in depth against a key containing `..`/absolute-
        path segments escaping base_dir (e.g. via a caller that builds a
        key from unsanitized user input). resolve() collapses those before
        the containment check, whether or not the target path exists yet."""
        path = (self._base_dir / key).resolve()
        base = self._base_dir.resolve()
        if not path.is_relative_to(base):
            raise ValueError(f"storage key escapes base_dir: {key!r}")
        return path
