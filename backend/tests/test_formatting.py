from app.documents.formatting import build_document_event_detail, format_file_size


def test_format_file_size_under_1024_bytes_has_no_decimal() -> None:
    assert format_file_size(500) == "500 B"


def test_format_file_size_zero_bytes() -> None:
    assert format_file_size(0) == "0 B"


def test_format_file_size_at_the_1024_boundary_rolls_over_to_kb() -> None:
    # 1024 bytes is the smallest value that is NOT rendered in bytes -
    # `< 1024` is the frontend's own boundary check (formatFileSize.ts).
    assert format_file_size(1023) == "1023 B"
    assert format_file_size(1024) == "1.0 KB"


def test_format_file_size_kilobytes_one_decimal_place() -> None:
    assert format_file_size(1536) == "1.5 KB"


def test_format_file_size_megabytes() -> None:
    assert format_file_size(1024 * 1024) == "1.0 MB"
    assert format_file_size(5 * 1024 * 1024 + 100_000) == "5.1 MB"


def test_format_file_size_gigabytes_stays_the_largest_unit() -> None:
    # unit_index is capped at len(units) - 1 (GB), mirroring the frontend's
    # own `unitIndex < units.length - 1` loop guard - there is no TB tier.
    assert format_file_size(1024**3) == "1.0 GB"
    assert format_file_size(2 * 1024**3) == "2.0 GB"


def test_build_document_event_detail_without_known_size_is_a_single_line() -> None:
    # A legacy pre-0006-migration row where file_size_bytes is still NULL -
    # must render exactly as it did before this feature, no second line,
    # no trailing newline, no "None" anywhere.
    detail = build_document_event_detail("x.txt", None)
    assert detail == "filename = x.txt"
    assert "\n" not in detail
    assert "None" not in detail


def test_build_document_event_detail_with_known_size_adds_a_second_line() -> None:
    assert (
        build_document_event_detail("x.txt", 1024)
        == "filename = x.txt\nfilesize = 1.0 KB"
    )


def test_build_document_event_detail_uses_format_file_size_for_the_second_line() -> None:
    size = 5 * 1024 * 1024 + 100_000
    detail = build_document_event_detail("report.pdf", size)
    assert detail == f"filename = report.pdf\nfilesize = {format_file_size(size)}"


def test_build_document_event_detail_with_token_count_adds_a_third_line() -> None:
    assert (
        build_document_event_detail("x.txt", 1024, 500)
        == "filename = x.txt\nfilesize = 1.0 KB\ntokens = 500"
    )


def test_build_document_event_detail_token_count_defaults_to_none_and_is_unchanged() -> None:
    # Regression check: omitting the new third arg entirely must produce
    # exactly today's 1-or-2-line output, no "tokens" line, no behavior
    # change for any existing caller.
    assert build_document_event_detail("x.txt", None) == "filename = x.txt"
    assert (
        build_document_event_detail("x.txt", 1024)
        == "filename = x.txt\nfilesize = 1.0 KB"
    )
