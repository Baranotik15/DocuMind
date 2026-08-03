import math
from datetime import datetime, timedelta, timezone
from typing import Literal

import numpy as np
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from umap import UMAP

from app.db import get_session

router = APIRouter()

# FastAPI 422s any query value outside this set automatically - no other
# router in this codebase validates a query param yet, so there's no prior
# idiom to follow; a bare Literal-typed parameter is FastAPI/pydantic's
# standard way to do this.
DashboardRange = Literal["day", "7days", "month", "year"]

# range -> (bucket count, bucket width) for the three ranges that are pure
# rolling windows from "now" (unlike `year`, which is calendar-aligned - see
# _month_bucket_starts below).
_ROLLING_WINDOWS: dict[str, tuple[int, timedelta]] = {
    "day": (12, timedelta(hours=2)),
    "7days": (7, timedelta(days=1)),
    "month": (5, timedelta(days=7)),
}


def _event_summary(row) -> dict:
    return {
        "id": str(row.id),
        "type": row.type,
        "timestamp": row.created_at.isoformat(),
        "detail": row.detail,
    }


@router.get("/dashboard/events")
async def get_dashboard_events(session: AsyncSession = Depends(get_session)) -> list[dict]:
    """Returns all dashboard_events as {id, type, timestamp, detail},
    ordered by created_at descending (newest first) - the opposite order
    from chat's list_messages endpoint, which is ascending. See
    `.claude/plans/2026-08-01-phase-2-backend-integration.md` Task 9."""
    rows = (
        await session.execute(
            text(
                "SELECT id, type, detail, created_at FROM dashboard_events "
                "ORDER BY created_at DESC"
            )
        )
    ).all()
    return [_event_summary(row) for row in rows]


def _month_bucket_starts(now: datetime, count: int = 12) -> list[datetime]:
    """Calendar-aligned bucket starts for the `year` range: `count` bucket
    starts, one per calendar month, each on the 1st of its month at
    00:00 UTC, ending with the current (possibly incomplete) month. Unlike
    the rolling `day`/`7days`/`month` ranges below, this is calendar-aligned
    rather than a pure trailing window from `now` - so boundaries land on
    the 1st of the month, not on exactly-30-day marks."""
    starts: list[datetime] = []
    year, month = now.year, now.month
    for _ in range(count):
        starts.append(datetime(year, month, 1, tzinfo=timezone.utc))
        month -= 1
        if month == 0:
            month, year = 12, year - 1
    starts.reverse()
    return starts


def _bucket_starts(range_: DashboardRange, now: datetime) -> list[datetime]:
    """The fixed-count, evenly-spaced bucket start times for `range_`,
    earliest first, ending with the bucket that covers `now`."""
    if range_ == "year":
        return _month_bucket_starts(now)
    count, width = _ROLLING_WINDOWS[range_]
    return [now - width * (count - i) for i in range(count)]


def _bucket_index(bucket_starts: list[datetime], created_at: datetime) -> int | None:
    """Which bucket `created_at` falls into. Bucket i covers
    [bucket_starts[i], bucket_starts[i + 1]), except the last bucket, which
    is open-ended on its upper side (covers everything from its start
    onward) - safe because no row can have a future created_at, so nothing
    beyond `now` can ever land there anyway. Returns None if `created_at`
    predates the very first bucket (outside the requested window)."""
    if created_at < bucket_starts[0]:
        return None
    for i in range(len(bucket_starts) - 1):
        if bucket_starts[i] <= created_at < bucket_starts[i + 1]:
            return i
    return len(bucket_starts) - 1


def _zero_filled_buckets(bucket_starts: list[datetime], created_ats: list[datetime]) -> list[dict]:
    """Buckets `created_ats` (a list of created_at timestamps already
    filtered to whichever rows should count, e.g. all messages vs. just
    disliked ones) against `bucket_starts`, always returning exactly
    len(bucket_starts) entries - including {"count": 0} for buckets with no
    matching rows, never omitted."""
    counts = [0] * len(bucket_starts)
    for created_at in created_ats:
        index = _bucket_index(bucket_starts, created_at)
        if index is not None:
            counts[index] += 1
    return [
        {"bucketStart": start.isoformat(), "count": count}
        for start, count in zip(bucket_starts, counts)
    ]


@router.get("/dashboard/stats")
async def get_dashboard_stats(
    range: DashboardRange, session: AsyncSession = Depends(get_session)
) -> dict:
    """Aggregate dashboard stats for the trailing window named by `range`
    (one of "day", "7days", "month", "year" - anything else 422s, enforced
    by the Literal type on the `range` param).

    `totalChunks`/`totalDocuments`/`totalDislikes` are unfiltered counts
    across ALL time (not scoped to `range` at all) - `totalDislikes` in
    particular is deliberately a separate, all-time count from
    `dislikeBuckets` below, which only covers the trailing window `range`
    implies.

    `messageBuckets`/`dislikeBuckets` are built from a single SELECT over
    chat_messages within the window (bucketed in Python, not SQL - see
    _bucket_starts/_bucket_index/_zero_filled_buckets above), each always
    exactly as many buckets as `range` implies, zero-filled where empty:
      - day:   12 buckets, 2h wide,  trailing 24h
      - 7days:  7 buckets, 24h wide, trailing 7 days
      - month:  5 buckets, 7d wide,  trailing 35 days
      - year:  12 buckets, 1 calendar month wide, trailing 12 calendar
               months (calendar-aligned, unlike the other three)
    `messageBuckets` counts every chat_messages row (both roles, disliked
    or not); `dislikeBuckets` counts only rows where disliked = true.
    """
    now = datetime.now(timezone.utc)
    bucket_starts = _bucket_starts(range, now)

    total_chunks = (
        await session.execute(text("SELECT COUNT(*) FROM chunks"))
    ).scalar_one()
    total_documents = (
        await session.execute(text("SELECT COUNT(*) FROM documents"))
    ).scalar_one()
    total_dislikes = (
        await session.execute(
            text("SELECT COUNT(*) FROM chat_messages WHERE disliked = true")
        )
    ).scalar_one()

    rows = (
        await session.execute(
            text(
                "SELECT created_at, disliked FROM chat_messages "
                "WHERE created_at >= :since"
            ),
            {"since": bucket_starts[0]},
        )
    ).all()

    return {
        # No users table exists yet - auth isn't built in this app. This is
        # a deliberate placeholder, not a bug; it'll need real counting
        # once auth (and a users table) exist.
        "totalUsers": 0,
        "totalChunks": total_chunks,
        "totalDocuments": total_documents,
        "totalDislikes": total_dislikes,
        "messageBuckets": _zero_filled_buckets(
            bucket_starts, [row.created_at for row in rows]
        ),
        "dislikeBuckets": _zero_filled_buckets(
            bucket_starts, [row.created_at for row in rows if row.disliked]
        ),
    }


def _parse_embedding(embedding_text: str) -> list[float]:
    """Parses pgvector's bracketed-CSV text format (e.g. "[0.1,0.2]" - the
    same format `app.vectors.format_vector` produces on the way in) back
    into a list of floats. Nothing else in this codebase reads a raw
    embedding back out of Postgres - there's no pgvector Python codec
    registered anywhere (see app/db.py, a plain SQLAlchemy async engine) -
    so a `chunks.embedding::text` cast plus this parser is the only way to
    get one back out."""
    return [float(v) for v in embedding_text.strip("[]").split(",")]


def _small_n_positions(n: int) -> list[tuple[float, float, float]]:
    """Deterministic placement for n < 4 points, evenly spaced around a
    unit circle in the XY plane (z=0), indexed by input order. UMAP isn't
    meaningful (and may error outright) on this few points, so this
    sidesteps it entirely - exact placement doesn't matter, only that it's
    stable and non-crashing. Also handles n == 0 (returns []): range(0) is
    empty, so the division below is never evaluated."""
    return [
        (math.cos(2 * math.pi * i / n), math.sin(2 * math.pi * i / n), 0.0)
        for i in range(n)
    ]


def _project_to_3d(embeddings: list[list[float]]) -> list[tuple[float, float, float]]:
    """Projects each 1536-dim embedding in `embeddings` down to one 3D
    (x, y, z) position, in the same order as the input, via UMAP
    (n_components=3) - so the frontend's Obsidian-style graph view can
    place semantically-similar chunks close together.

    `random_state=42` is fixed so repeated calls against the same data
    return numerically identical coordinates every time (UMAP forces
    n_jobs=1 whenever random_state is set, specifically to guarantee this
    reproducibility) - the frontend re-fetches this on demand and the
    graph shouldn't visually jump around between fetches if nothing
    changed.

    `n_neighbors` (UMAP's own default is 15, which errors/warns once the
    sample count drops to at or below it) is clamped to
    min(15, len(embeddings) - 1).

    Fewer than 4 points skips UMAP entirely in favor of _small_n_positions
    above - UMAP isn't meaningful (and may error outright) on that few
    points. Zero points returns an empty list.
    """
    n = len(embeddings)
    if n < 4:
        return _small_n_positions(n)

    reducer = UMAP(n_components=3, random_state=42, n_neighbors=min(15, n - 1))
    coordinates = reducer.fit_transform(np.asarray(embeddings, dtype=np.float64))
    return [(float(x), float(y), float(z)) for x, y, z in coordinates]


def _chunk_graph_node(row, coordinates: tuple[float, float, float]) -> dict:
    x, y, z = coordinates
    return {
        "id": str(row.id),
        "documentId": str(row.document_id),
        "filename": row.filename,
        "x": x,
        "y": y,
        "z": z,
        # The chunk's own position within its document (not an index into
        # this response) - lets the frontend chain same-document nodes in
        # reading order (chunk 1 -> chunk 2 -> chunk 3 -> ...) rather than
        # connecting every chunk to every other chunk in the document.
        "position": row.position,
    }


@router.get("/dashboard/chunk-graph")
async def get_chunk_graph(session: AsyncSession = Depends(get_session)) -> dict:
    """Returns one 3D position per chunk, across ALL chunks regardless of
    document status (same unfiltered convention as totalChunks/
    totalDocuments on GET /internal/dashboard/stats above) - powers a
    frontend Obsidian-style 3D graph view, where each chunk is a node and
    semantically-similar chunks (by embedding) end up positioned close
    together. The 3D rendering and same-document link-drawing both happen
    frontend-side (chained by `position` in reading order, not an all-pairs
    connection); this endpoint's only job is the one 3D position per chunk,
    plus that chunk's own position within its document:

        {"nodes": [{"id", "documentId", "filename", "x", "y", "z", "position"}, ...]}

    x/y/z come from projecting each chunk's 1536-dim embedding down to 3
    dimensions via UMAP with a fixed random_state (see _project_to_3d) -
    repeated calls against unchanged data return numerically identical
    coordinates, since the frontend re-fetches this on demand and the
    graph shouldn't visually jump around between fetches if nothing
    changed. Fewer than 4 total chunks skips UMAP (not meaningful, and may
    error outright, on that few points) in favor of a simple deterministic
    placement instead (see _small_n_positions); zero chunks returns
    {"nodes": []}.

    Rows are ordered by chunks.id so that, combined with the above, the
    full response is stable across repeated calls - not just each node's
    own coordinates, but their order in the list too.
    """
    rows = (
        await session.execute(
            text(
                "SELECT chunks.id, chunks.document_id, chunks.position, documents.filename, "
                "chunks.embedding::text AS embedding_text "
                "FROM chunks "
                "JOIN documents ON documents.id = chunks.document_id "
                "ORDER BY chunks.id"
            )
        )
    ).all()

    coordinates = _project_to_3d([_parse_embedding(row.embedding_text) for row in rows])

    return {
        "nodes": [
            _chunk_graph_node(row, node_coordinates)
            for row, node_coordinates in zip(rows, coordinates)
        ]
    }
