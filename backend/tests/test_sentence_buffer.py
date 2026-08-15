from app.chat.sentence_buffer import SentenceBuffer


def test_add_returns_empty_until_terminator_and_whitespace_confirmed() -> None:
    """A terminator arriving with no trailing text yet (delta 3 ends exactly
    on ".") must NOT fire early - only once a future delta supplies
    whitespace after it does the sentence come out."""
    buffer = SentenceBuffer()

    assert buffer.add("Hel") == []
    assert buffer.add("lo there") == []
    assert buffer.add(".") == []
    assert buffer.add(" How are you?") == ["Hello there."]


def test_single_delta_can_complete_two_sentences_at_once() -> None:
    buffer = SentenceBuffer()

    assert buffer.add("Well") == []
    assert buffer.add(" Yes. No. ") == ["Well Yes.", "No."]


def test_trailing_text_with_no_terminator_stays_buffered_until_flush() -> None:
    buffer = SentenceBuffer()

    assert buffer.add("and ") == []
    assert buffer.add("so") == []
    assert buffer.flush() == "and so"


def test_flush_returns_trailing_terminator_never_confirmed_by_whitespace() -> None:
    """Once the stream is genuinely over, a trailing terminator with no
    whitespace after it (because nothing more ever arrived) is still a
    real sentence end - flush() must return it, unlike add()."""
    buffer = SentenceBuffer()

    assert buffer.add("Done.") == []
    assert buffer.flush() == "Done."


def test_flush_on_empty_buffer_returns_none() -> None:
    buffer = SentenceBuffer()

    assert buffer.flush() is None
