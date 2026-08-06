"""add chat_messages.no_answer_found, disliked_at, question_id

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-05

"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: Union[str, Sequence[str], None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "chat_messages",
        sa.Column("no_answer_found", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # NULL whenever the message isn't currently disliked (never disliked,
    # or disliked then un-disliked again) - lets the Improvements page's
    # Dislikes list filter by *when it was disliked*, independent of
    # created_at (a message can sit in history a while before someone
    # dislikes it).
    op.add_column(
        "chat_messages",
        sa.Column("disliked_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Self-referencing FK, set only on assistant-role rows, pointing at the
    # user-role row that prompted them - lets the Improvements page show
    # the actual question behind a dislike/no-answer entry, not just the
    # assistant's own (often near-identical) reply text. ON DELETE SET
    # NULL rather than CASCADE: deleting a user message should never
    # silently delete the assistant reply that answered it.
    op.add_column(
        "chat_messages",
        sa.Column(
            "question_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("chat_messages.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("chat_messages", "question_id")
    op.drop_column("chat_messages", "disliked_at")
    op.drop_column("chat_messages", "no_answer_found")
