from app.vectors import format_vector


def test_format_vector_formats_as_bracketed_csv() -> None:
    result = format_vector([0.1, -0.2, 3.0])

    assert result == "[0.1,-0.2,3.0]"


def test_format_vector_round_trips_to_same_floats() -> None:
    values = [0.1, -0.2, 3.0, 1e-10, -42.5]

    result = format_vector(values)

    assert result.startswith("[") and result.endswith("]")
    parsed = [float(x) for x in result[1:-1].split(",")]
    assert parsed == values


def test_format_vector_empty_list_returns_empty_brackets() -> None:
    assert format_vector([]) == "[]"
