def format_vector(values: list[float]) -> str:
    """Formats an embedding as a pgvector text literal, e.g. "[0.1,0.2]",
    for use in a raw SQL `:param::vector` cast. Uses repr() per float so
    formatting is deterministic (no locale/rounding surprises)."""
    return "[" + ",".join(repr(value) for value in values) + "]"
