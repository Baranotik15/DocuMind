"""add chat_messages.slack_channel_id, slack_message_ts

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-06

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0010"
down_revision: Union[str, Sequence[str], None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Together, identify which Slack message (channel + ts - Slack's own
    # composite identifier for a specific posted message within a channel) a
    # chat_messages row *is*, so a later reaction_added/reaction_removed
    # webhook event (which only carries event.item.channel/event.item.ts, no
    # reference back to our own chat_messages.id) can be matched back to the
    # row that posted it - see app/slack/service.py::handle_reaction. NULL
    # for every row except Slack-channel assistant replies that were
    # successfully posted via chat.postMessage: admin-channel rows and Slack
    # *user*-question rows have no posted-message identity of their own to
    # track, and a failed/errored post also leaves both NULL (see
    # _answer_and_post - not a fatal condition, that reply just can't be
    # dislike-tracked via a reaction).
    #
    # No index added here: this codebase's existing lookup-heavy/FK columns
    # (chat_messages.question_id, chat_messages.channel,
    # chat_messages.external_identity, chunks.document_id, ...) are all
    # left unindexed too - only genuinely-unique columns (documents.filename,
    # users.email, sessions.token_hash) get an (implicit, via unique=True)
    # index anywhere in this schema. Matching that precedent rather than
    # introducing the first plain non-unique index in the codebase.
    op.add_column(
        "chat_messages",
        sa.Column("slack_channel_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "chat_messages",
        sa.Column("slack_message_ts", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_messages", "slack_message_ts")
    op.drop_column("chat_messages", "slack_channel_id")
