from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

sync_engine: Engine = create_engine(get_settings().database_url_sync)
SyncSessionLocal: sessionmaker[Session] = sessionmaker(bind=sync_engine)
