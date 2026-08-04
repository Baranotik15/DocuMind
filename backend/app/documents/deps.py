from pathlib import Path

from app.config import get_settings
from app.documents.storage import LocalDiskStorage, StorageAdapter


def get_storage() -> StorageAdapter:
    """Returns a LocalDiskStorage rooted at get_settings().storage_base_dir,
    creating the directory if needed. FastAPI dependency for endpoints;
    Celery tasks (Task 5) call this directly (not via Depends)."""
    base_dir = Path(get_settings().storage_base_dir)
    base_dir.mkdir(parents=True, exist_ok=True)
    return LocalDiskStorage(base_dir)
