"""add dashboard_events.user_email

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-05

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: Union[str, Sequence[str], None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable - populated from the originating authenticated request's
    # user_email for every event type this app currently records,
    # including the three chunking-pipeline events (chunking_started/
    # succeeded/failed), which fire inside a Celery worker task but always
    # trace back 1:1 to an authenticated upload or Save that threads its
    # user_email through (see app/documents/tasks.py, app/documents/
    # pipeline.py). Stays nullable for whichever future event type/caller
    # genuinely has no user to attribute it to.
    op.add_column("dashboard_events", sa.Column("user_email", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("dashboard_events", "user_email")
