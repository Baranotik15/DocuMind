from enum import StrEnum


class ChatRole(StrEnum):
    """Canonical `chat_messages.role` column values."""

    USER = "user"
    ASSISTANT = "assistant"
