import tiktoken

from app.chunks.tokens import count_tokens


def test_count_tokens_empty_string_returns_zero() -> None:
    assert count_tokens("") == 0


def test_count_tokens_matches_cl100k_base_encoding_directly() -> None:
    text = "hello world"
    expected = len(tiktoken.get_encoding("cl100k_base").encode(text))

    result = count_tokens(text)

    assert result == expected
    assert result > 0


def test_count_tokens_scales_up_for_longer_text() -> None:
    short_text = "hello world"
    long_text = "hello world, this is a much longer piece of text. " * 50

    assert count_tokens(long_text) > count_tokens(short_text)
