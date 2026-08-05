import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import text

from app.chunks.headings import HeadingMarker
from app.chunks.tokens import count_tokens
from app.db.sync_session import SyncSessionLocal
from app.documents.formatting import format_file_size
from app.documents.pipeline import (
    DocumentProcessingError,
    run_pipeline,
    run_pipeline_with_manual_chunks,
)

ZERO_VECTOR_1536 = "[" + ",".join(["0"] * 1536) + "]"


@pytest.fixture(autouse=True)
def _celery_eager() -> None:
    # run_pipeline itself is plain sync code, not a Celery task, but this
    # matches the project-wide convention (test_smoke_job.py) of forcing
    # eager execution so no test ever waits on a broker/worker round trip.
    from app.worker.celery_app import celery_app

    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True


def _insert_document(
    session, *, status: str = "uploaded", file_size_bytes: int | None = None
) -> tuple[str, str]:
    filename = f"pipeline-{uuid.uuid4()}.txt"
    document_id = session.execute(
        text(
            "INSERT INTO documents (filename, storage_key, status, file_size_bytes) "
            "VALUES (:filename, :storage_key, :status, :file_size_bytes) RETURNING id"
        ),
        {
            "filename": filename,
            "storage_key": f"docs/{filename}",
            "status": status,
            "file_size_bytes": file_size_bytes,
        },
    ).scalar_one()
    session.commit()
    return str(document_id), filename


def _document_status(session, document_id: str) -> str:
    return session.execute(
        text("SELECT status FROM documents WHERE id = :document_id"),
        {"document_id": document_id},
    ).scalar_one()


def _chunk_rows(session, document_id: str) -> list:
    return session.execute(
        text(
            "SELECT position, original_content, edited_content, embedding "
            "FROM chunks WHERE document_id = :document_id ORDER BY position"
        ),
        {"document_id": document_id},
    ).all()


def _matching_events(session, event_type: str, filename: str) -> list:
    """Rows (detail, user_email) of `event_type` events that carry this
    test's own filename in `detail` - the type alone isn't unique to a
    single test on this live-shared table, so every caller filters down
    to its own document by filename the same way `_cleanup` does."""
    rows = session.execute(
        text("SELECT detail, user_email FROM dashboard_events WHERE type = :type"),
        {"type": event_type},
    ).all()
    return [row for row in rows if filename in row.detail]


def _cleanup(document_id: str, filename: str) -> None:
    # Also deletes every dashboard_events row this test's own run_pipeline/
    # run_pipeline_with_manual_chunks call created (document.chunking_
    # started/succeeded/failed - see app.documents.pipeline's
    # record_event_sync call sites) so it never lingers in the live-shared
    # dashboard_events table the live Dashboard reads from - every one of
    # those rows embeds `filename=<name>` in `detail`, so a LIKE match on
    # this test's own filename is precise and doesn't touch any other
    # test's rows.
    with SyncSessionLocal() as session:
        session.execute(
            text(
                "DELETE FROM dashboard_events WHERE detail LIKE "
                "'%' || :filename || '%'"
            ),
            {"filename": filename},
        )
        session.execute(
            text("DELETE FROM documents WHERE id = :document_id"),
            {"document_id": document_id},
        )
        session.commit()


async def _fake_embed_texts(texts: list[str]) -> list[list[float]]:
    return [[0.1] * 1536 for _ in texts]


def test_run_pipeline_success_leaves_document_ready_with_exact_reconstruction() -> None:
    # No headings given (the Save-triggered automatic re-chunk path, and any
    # caller with no format-native structure) - split_document's own
    # tier 1/3 text-pattern detectors find nothing in this plain prose, so
    # it falls all the way back to today's paragraph/token-limited
    # behavior, unchanged from before this feature.
    source_text = "First paragraph of the document.\n\nSecond paragraph, a bit longer.\n\nThird and final paragraph."

    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session)

    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                run_pipeline(document_id, source_text, session)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "ready"

            rows = _chunk_rows(session, document_id)
            assert len(rows) > 0
            assert "".join(row.edited_content for row in rows) == source_text
            assert "".join(row.original_content for row in rows) == source_text
            assert [row.position for row in rows] == list(range(len(rows)))
            for row in rows:
                assert row.embedding is not None

            started = _matching_events(session, "document.chunking_started", filename)
            succeeded = _matching_events(session, "document.chunking_succeeded", filename)
            assert started
            assert succeeded
            # This test calls run_pipeline directly with no user_email
            # given, so it lands as None here - not because it structurally
            # can't be otherwise (see
            # test_run_pipeline_records_the_given_user_email_on_pipeline_events
            # below for the case where one is passed through).
            assert all(row.user_email is None for row in started + succeeded)
    finally:
        _cleanup(document_id, filename)


def test_run_pipeline_with_headings_splits_at_heading_boundaries_not_paragraphs() -> None:
    # Deliberately no blank-line paragraph breaks anywhere in this text, and
    # both sections are well under DEFAULT_MAX_TOKENS - so the tier 5/6/7
    # paragraph/token-limited fallback alone (headings=None) would leave
    # this as a single chunk. Passing explicit headings must still split it
    # at exactly those offsets, proving split_document's given-headings
    # path (not its own tier 1/3 fallback, and not paragraph slicing) wins.
    first_title = "Introduction"
    second_title = "Refund Policy"
    source_text = (
        f"{first_title}\n"
        "This is the introduction body, with no blank line separating it "
        "from the heading above or the next section below.\n"
        f"{second_title}\n"
        "This is the second section's body text, also with no blank-line "
        "paragraph break anywhere nearby."
    )
    second_offset = source_text.index(second_title)
    headings = [
        HeadingMarker(offset=0, level=1),
        HeadingMarker(offset=second_offset, level=1),
    ]

    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session)

    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                run_pipeline(document_id, source_text, session, headings=headings)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "ready"

            rows = _chunk_rows(session, document_id)
            assert "".join(row.edited_content for row in rows) == source_text
            assert "".join(row.original_content for row in rows) == source_text
            assert [row.position for row in rows] == list(range(len(rows)))

            # Exactly one chunk per given heading, split at each heading's
            # own offset - not wherever paragraph/token limits alone would
            # have landed (which would have been a single chunk here).
            assert len(rows) == 2
            assert rows[0].original_content == source_text[:second_offset]
            assert rows[1].original_content == source_text[second_offset:]
    finally:
        _cleanup(document_id, filename)


def test_run_pipeline_records_the_given_user_email_on_pipeline_events() -> None:
    # Direct plumbing coverage for user_email flowing from run_pipeline's
    # own parameter down through _start_chunking/_replace_chunks into
    # _transition_status's record_event_sync call - the end-to-end router
    # tests (test_documents_router.py, test_chunks_router.py) cover the
    # same thing via a real authenticated request, but this isolates the
    # pipeline's own plumbing from the HTTP layer.
    source_text = "Some source text.\n\nWith two paragraphs."
    given_email = "pipeline-plumbing-test@example.com"

    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session)

    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                run_pipeline(document_id, source_text, session, user_email=given_email)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "ready"

            started = _matching_events(session, "document.chunking_started", filename)
            succeeded = _matching_events(session, "document.chunking_succeeded", filename)
            assert started
            assert succeeded
            assert all(row.user_email == given_email for row in started + succeeded)
    finally:
        _cleanup(document_id, filename)


def test_run_pipeline_records_filesize_in_chunking_event_details_when_known() -> None:
    # _transition_status's detail string goes through the same
    # build_document_event_detail as documents/router.py's upload/delete
    # events (see app.documents.formatting) - a document inserted with a
    # known file_size_bytes should carry a 'filesize = ...' second line on
    # both its chunking_started and chunking_succeeded events, not just
    # 'filename = ...'.
    source_text = "Some source text.\n\nWith two paragraphs."
    known_size = 12345

    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session, file_size_bytes=known_size)

    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                run_pipeline(document_id, source_text, session)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "ready"

            started = _matching_events(session, "document.chunking_started", filename)
            succeeded = _matching_events(session, "document.chunking_succeeded", filename)
            assert started
            assert succeeded
            expected_filesize_line = f"filesize = {format_file_size(known_size)}"
            assert all(
                f"filename = {filename}" in row.detail
                and expected_filesize_line in row.detail
                for row in started + succeeded
            )
    finally:
        _cleanup(document_id, filename)


def test_run_pipeline_records_token_count_only_on_chunking_succeeded_event() -> None:
    # Tokens are only knowable once chunking + embedding have both
    # succeeded (see documents/pipeline.py's _replace_chunks) - never on
    # chunking_started, which fires before embedding even runs. The
    # expected count is computed the same way production code does, summed
    # over the actual chunk texts that landed in the DB (proven elsewhere,
    # e.g. test_run_pipeline_success_leaves_document_ready_with_exact_
    # reconstruction, to be exactly the list run_pipeline embedded) - never
    # a hardcoded magic number.
    source_text = "First paragraph of the document.\n\nSecond paragraph, a bit longer.\n\nThird and final paragraph."

    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session)

    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                run_pipeline(document_id, source_text, session)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "ready"

            rows = _chunk_rows(session, document_id)
            expected_token_count = sum(count_tokens(row.original_content) for row in rows)

            started = _matching_events(session, "document.chunking_started", filename)
            succeeded = _matching_events(session, "document.chunking_succeeded", filename)
            assert started
            assert succeeded
            assert all("tokens = " not in row.detail for row in started)
            assert all(
                f"tokens = {expected_token_count}" in row.detail for row in succeeded
            )
    finally:
        _cleanup(document_id, filename)


def test_run_pipeline_with_whitespace_only_source_text_marks_document_failed() -> None:
    # Reproduces the scanned-PDF bug: pypdf/extract_text can "succeed" (no
    # exception) while returning nothing but newlines - e.g. one \n per page
    # of an image-only PDF with no text layer. That must be treated as a
    # pipeline failure, not silently chunked/embedded into a useless
    # whitespace-only chunk that lands the document at 'ready'.
    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session)

    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                with pytest.raises(DocumentProcessingError):
                    run_pipeline(document_id, "\n\n\n", session)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "failed"

            matching = _matching_events(session, "document.chunking_failed", filename)
            assert matching
            assert all(
                len(row.detail) > 0
                and row.user_email is None
                and "tokens = " not in row.detail
                for row in matching
            )

            rows = _chunk_rows(session, document_id)
            assert len(rows) == 0
    finally:
        _cleanup(document_id, filename)


def test_run_pipeline_failure_marks_document_failed_and_leaves_old_chunks_untouched() -> None:
    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session, status="ready")
        session.execute(
            text(
                "INSERT INTO chunks "
                "(document_id, position, original_content, edited_content, embedding) "
                "VALUES (:document_id, 0, :content, :content, :embedding ::vector)"
            ),
            {
                "document_id": document_id,
                "content": "pre-existing chunk, untouched by a failed re-chunk",
                "embedding": ZERO_VECTOR_1536,
            },
        )
        session.commit()

    try:
        failing_embed_texts = AsyncMock(side_effect=RuntimeError("embedding API down"))
        with patch("app.documents.pipeline.embed_texts", new=failing_embed_texts):
            with SyncSessionLocal() as session:
                with pytest.raises(DocumentProcessingError):
                    run_pipeline(document_id, "some new source text", session)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "failed"

            matching = _matching_events(session, "document.chunking_failed", filename)
            assert matching
            # embed_texts itself raised here (never returned), so a token
            # count could never have been computed - confirms the failure
            # path never leaks a stale/partial count into the event.
            assert all(
                len(row.detail) > 0
                and row.user_email is None
                and "tokens = " not in row.detail
                for row in matching
            )

            rows = _chunk_rows(session, document_id)
            assert len(rows) == 1
            assert rows[0].original_content == (
                "pre-existing chunk, untouched by a failed re-chunk"
            )
    finally:
        _cleanup(document_id, filename)


def test_run_pipeline_with_manual_chunks_skips_split_and_embeds_exact_chunks() -> None:
    # No blank-line paragraph separators between these, and well under the
    # 1500-char max_chars limit - if this were joined and run through
    # split_into_chunks, it would collapse into a single chunk. Getting
    # back exactly 3 chunks, matching this list verbatim, proves the
    # algorithmic splitter was never invoked.
    chunk_texts = [
        "Chunk one content without a paragraph break.",
        "Chunk two content, also no break here.",
        "Chunk three, final content.",
    ]

    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session)

    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                run_pipeline_with_manual_chunks(document_id, chunk_texts, session)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "ready"

            rows = _chunk_rows(session, document_id)
            assert len(rows) == len(chunk_texts)
            assert [row.edited_content for row in rows] == chunk_texts
            assert [row.original_content for row in rows] == chunk_texts
            assert [row.position for row in rows] == list(range(len(rows)))
            for row in rows:
                assert row.embedding is not None

            assert _matching_events(session, "document.chunking_started", filename)
            assert _matching_events(session, "document.chunking_succeeded", filename)
    finally:
        _cleanup(document_id, filename)


def test_run_pipeline_with_manual_chunks_empty_list_marks_document_failed() -> None:
    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session, status="ready")
        session.execute(
            text(
                "INSERT INTO chunks "
                "(document_id, position, original_content, edited_content, embedding) "
                "VALUES (:document_id, 0, :content, :content, :embedding ::vector)"
            ),
            {
                "document_id": document_id,
                "content": "pre-existing chunk, untouched by an empty manual list",
                "embedding": ZERO_VECTOR_1536,
            },
        )
        session.commit()

    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                with pytest.raises(DocumentProcessingError):
                    run_pipeline_with_manual_chunks(document_id, [], session)

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "failed"

            matching = _matching_events(session, "document.chunking_failed", filename)
            assert matching
            assert all(len(row.detail) > 0 and row.user_email is None for row in matching)

            rows = _chunk_rows(session, document_id)
            assert len(rows) == 1
            assert rows[0].original_content == (
                "pre-existing chunk, untouched by an empty manual list"
            )
    finally:
        _cleanup(document_id, filename)


def test_run_pipeline_with_manual_chunks_whitespace_only_chunk_marks_document_failed() -> None:
    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session, status="ready")
        session.execute(
            text(
                "INSERT INTO chunks "
                "(document_id, position, original_content, edited_content, embedding) "
                "VALUES (:document_id, 0, :content, :content, :embedding ::vector)"
            ),
            {
                "document_id": document_id,
                "content": "pre-existing chunk, untouched by a blank manual chunk",
                "embedding": ZERO_VECTOR_1536,
            },
        )
        session.commit()

    try:
        with patch(
            "app.documents.pipeline.embed_texts", new=AsyncMock(side_effect=_fake_embed_texts)
        ):
            with SyncSessionLocal() as session:
                with pytest.raises(DocumentProcessingError):
                    run_pipeline_with_manual_chunks(
                        document_id, ["a real chunk", "   \n  "], session
                    )

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "failed"

            matching = _matching_events(session, "document.chunking_failed", filename)
            assert matching
            assert all(len(row.detail) > 0 and row.user_email is None for row in matching)

            rows = _chunk_rows(session, document_id)
            assert len(rows) == 1
            assert rows[0].original_content == (
                "pre-existing chunk, untouched by a blank manual chunk"
            )
    finally:
        _cleanup(document_id, filename)


def test_run_pipeline_with_manual_chunks_failure_marks_document_failed_and_leaves_old_chunks_untouched() -> None:
    with SyncSessionLocal() as session:
        document_id, filename = _insert_document(session, status="ready")
        session.execute(
            text(
                "INSERT INTO chunks "
                "(document_id, position, original_content, edited_content, embedding) "
                "VALUES (:document_id, 0, :content, :content, :embedding ::vector)"
            ),
            {
                "document_id": document_id,
                "content": "pre-existing chunk, untouched by a failed manual re-chunk",
                "embedding": ZERO_VECTOR_1536,
            },
        )
        session.commit()

    try:
        failing_embed_texts = AsyncMock(side_effect=RuntimeError("embedding API down"))
        with patch("app.documents.pipeline.embed_texts", new=failing_embed_texts):
            with SyncSessionLocal() as session:
                with pytest.raises(DocumentProcessingError):
                    run_pipeline_with_manual_chunks(
                        document_id, ["new chunk one", "new chunk two"], session
                    )

        with SyncSessionLocal() as session:
            assert _document_status(session, document_id) == "failed"

            matching = _matching_events(session, "document.chunking_failed", filename)
            assert matching
            assert all(len(row.detail) > 0 and row.user_email is None for row in matching)

            rows = _chunk_rows(session, document_id)
            assert len(rows) == 1
            assert rows[0].original_content == (
                "pre-existing chunk, untouched by a failed manual re-chunk"
            )
    finally:
        _cleanup(document_id, filename)
