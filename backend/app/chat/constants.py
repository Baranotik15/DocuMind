from enum import StrEnum


class ChatRole(StrEnum):
    """Canonical `chat_messages.role` column values."""

    USER = "user"
    ASSISTANT = "assistant"


class ChatChannel(StrEnum):
    """Canonical `chat_messages.channel` column values - which surface a
    row originated from. "admin" is the in-app admin Chat page
    (app.chat.router.send_message/list_messages); "slack" is the Slack bot
    integration (app.slack.service._answer_and_post). Every "slack" row
    also has `external_identity` set to the Slack user id who sent it;
    "admin" rows never set it (no external-identity concept for the
    single-operator admin Chat page). Must match the migration's own
    `server_default="admin"` (see alembic/versions/0009_chat_messages_channel_scoping.py)."""

    ADMIN = "admin"
    SLACK = "slack"
