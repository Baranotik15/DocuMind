import tiktoken

# Loaded once at module import time - tiktoken.get_encoding is not cheap to
# call per-invocation (it loads/parses the encoding's merge ranks), so the
# encoder is built here and reused across every count_tokens call. This is
# the same encoding used by this app's embedding/chat models
# (text-embedding-3-small, gpt-4o-mini - see app/config.py).
_ENCODING = tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    """Returns the token count `text` would have under this app's
    embedding model's tokenizer (cl100k_base, shared by
    text-embedding-3-small and gpt-4o-mini). Empty string -> 0.
    Encoder is loaded once at module import time (tiktoken.get_encoding
    is not cheap to call per-invocation) and reused."""
    if not text:
        return 0
    return len(_ENCODING.encode(text))
