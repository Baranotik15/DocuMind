"""add chat_messages.channel and external_identity

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-06

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0009"
down_revision: Union[str, Sequence[str], None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Which surface a row originated from - "admin" (the in-app admin Chat
    # page) or "slack" (the Slack bot integration, see app/slack/service.py).
    # Every row up to this point came from the admin Chat page, the only
    # source until the Slack bot started writing to this table - the
    # 'admin' default backfills every existing row correctly with no
    # separate data migration needed.
    op.add_column(
        "chat_messages",
        sa.Column("channel", sa.Text(), nullable=False, server_default="admin"),
    )
    # Populated only for non-admin channels (e.g. the Slack user id who
    # sent the DM/mention that produced this row) - NULL for admin-channel
    # rows, which have no external-identity concept (a single logged-in
    # operator's own Chat page).
    op.add_column(
        "chat_messages",
        sa.Column("external_identity", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_messages", "external_identity")
    op.drop_column("chat_messages", "channel")
