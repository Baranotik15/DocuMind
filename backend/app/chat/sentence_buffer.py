_SENTENCE_TERMINATORS = (".", "!", "?")


class SentenceBuffer:
    """Re-groups a stream of small text deltas (as generate_reply_stream
    yields them) into complete sentences, so a caller can trigger TTS
    synthesis as soon as each sentence is ready instead of waiting for the
    whole reply. A simple heuristic, deliberately not a full NLP
    tokenizer (see the spec's Non-Goals) - good enough to trigger
    synthesis promptly, not required to be linguistically perfect."""

    def __init__(self) -> None:
        self._buffer = ""

    def add(self, delta: str) -> list[str]:
        """Appends `delta` to the internal buffer, then extracts every
        NEWLY complete sentence it can find: a terminator character
        (`.`/`!`/`?`) that is followed by at least one whitespace
        character already present in the buffer. A terminator with
        nothing (yet) after it is NOT treated as complete - more text may
        still be coming in a future delta - it stays buffered. A single
        delta can complete more than one short sentence at once (e.g. a
        delta like " Yes. No." arriving after enough prior buffered text) -
        returns all of them, in order, as a list (usually empty or
        length 1, but callers must handle more). Whatever remains after
        every complete sentence is extracted stays in the buffer for the
        next call."""
        self._buffer += delta

        sentences: list[str] = []
        start = 0
        buffer_length = len(self._buffer)
        # Stop one char short of the end: a terminator needs a following
        # character already present in the buffer to confirm it's not
        # mid-stream with more text still to come.
        for i in range(buffer_length - 1):
            if (
                self._buffer[i] in _SENTENCE_TERMINATORS
                and self._buffer[i + 1].isspace()
            ):
                sentences.append(self._buffer[start : i + 1].strip())
                start = i + 1

        self._buffer = self._buffer[start:]
        return sentences

    def flush(self) -> str | None:
        """Called once the underlying reply stream is exhausted - returns
        whatever text is still buffered (WITH its trailing terminator if
        it has one, even without confirming whitespace after it, since
        the stream is definitively over), trimmed. Returns None if
        nothing (or only whitespace) remains buffered."""
        remaining = self._buffer.strip()
        self._buffer = ""
        return remaining or None
