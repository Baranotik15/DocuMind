import asyncio
import logging
import math
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Awaitable, Callable, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import numpy as np
from fastapi import APIRouter, Depends
from openai import AsyncOpenAI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from umap import UMAP

from app.chat.constants import ChatRole
from app.config import get_settings
from app.dashboard.schemas import (
    ChunkGraph,
    ChunkGraphNode,
    DashboardStats,
    DashboardStatsBucket,
    OpenAiSpend,
    OpenAiSpendTokens,
    OpenAiSpendTokenWindow,
)
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter()

# FastAPI 422s any query value outside this set automatically - no other
# router in this codebase validates a query param yet, so there's no prior
# idiom to follow; a bare Literal-typed parameter is FastAPI/pydantic's
# standard way to do this.
DashboardRange = Literal["day", "7days", "month", "year"]


def _local_now(now: datetime, tz_name: str) -> tuple[datetime, ZoneInfo]:
    """Resolves `tz_name` (falling back to UTC for a missing, garbled, or
    otherwise unrecognized name - this endpoint has never 422'd on
    anything but the `range` Literal itself) and returns (`now` converted
    into that zone, the zone itself) - both are needed by every
    `_*_bucket_starts` function below, which previously each repeated this
    same resolve-then-convert preamble."""
    try:
        zone = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        zone = ZoneInfo("UTC")
    return now.astimezone(zone), zone


def _year_bucket_starts(now: datetime, tz_name: str) -> list[datetime]:
    """Calendar-aligned bucket starts for the `year` range: 12 buckets, one
    per calendar month, January through December of the CURRENT year in
    `tz_name` - not a trailing 12-month window ending at "now"'s month
    (which could straddle two calendar years, e.g. Sep-Aug). "This year"
    is `now` converted into `tz_name`, same as day/7days/month above."""
    local_now, zone = _local_now(now, tz_name)
    return [
        datetime(local_now.year, month, 1, tzinfo=zone).astimezone(timezone.utc)
        for month in range(1, 13)
    ]


def _day_bucket_starts(now: datetime, tz_name: str) -> list[datetime]:
    """Calendar-aligned bucket starts for the `day` range: 24 buckets, 1h
    wide, from local midnight (00:00) through local 23:00 of "today" in
    `tz_name`. "Today" is `now` converted into `tz_name`, so which calendar
    day this covers can shift with the selected zone (e.g. right after
    local midnight, "today" locally may still be "yesterday" in UTC).

    Returned starts are UTC-aware datetimes (converted back from local
    time) so they compare correctly against created_at, which is stored as
    UTC in Postgres, and so the response's bucketStart values stay
    absolute, UTC-serializable instants like every other range."""
    local_now, _zone = _local_now(now, tz_name)
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    return [
        (local_midnight + timedelta(hours=i)).astimezone(timezone.utc)
        for i in range(24)
    ]


def _week_bucket_starts(now: datetime, tz_name: str) -> list[datetime]:
    """Calendar-aligned bucket starts for the `7days` range: 7 buckets, 1
    day wide, Monday through Sunday of the CURRENT week in `tz_name` - not
    a trailing 7-day window from `now`. "This week" is `now` converted into
    `tz_name`, so which calendar week this covers can shift with the
    selected zone, same as `day`'s "today" (see _day_bucket_starts). The
    whole 7-bucket window only advances once local time crosses into the
    next Monday - it does not slide forward by a day at a time the way the
    old trailing window did.

    `datetime.weekday()` (Monday == 0) locates the current week's Monday by
    subtracting that many days from local midnight; returns UTC-aware
    datetimes for the same created_at-comparison reason as
    _day_bucket_starts."""
    local_now, _zone = _local_now(now, tz_name)
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    monday = local_midnight - timedelta(days=local_midnight.weekday())
    return [(monday + timedelta(days=i)).astimezone(timezone.utc) for i in range(7)]


def _month_range_bucket_starts(now: datetime, tz_name: str) -> list[datetime]:
    """Calendar-aligned bucket starts for the `month` range: 4 buckets
    within the CURRENT calendar month in `tz_name` - the 1st, 8th, 15th,
    and 22nd - not a trailing 35-day window from `now` (which could
    straddle two calendar months). "This month" is `now` converted into
    `tz_name`, same as `day`/`7days` above.

    The 4th bucket (22nd onward) is deliberately left open-ended rather
    than also locating the month's real last day (28/29/30/31): every
    range's final bucket is already open-ended on its upper side (see
    _bucket_index - nothing with a future created_at can ever exist), so
    the 22nd through however many days this particular month actually has
    left lands in that one bucket for free, per explicit request (the
    22nd-28th/29th/30th/31st stretch is one bucket, not a separate
    trailing sliver)."""
    local_now, zone = _local_now(now, tz_name)
    return [
        datetime(local_now.year, local_now.month, day, tzinfo=zone).astimezone(timezone.utc)
        for day in (1, 8, 15, 22)
    ]


def _bucket_starts(range_: DashboardRange, now: datetime, tz_name: str) -> list[datetime]:
    """The fixed-count bucket start times for `range_`, earliest first -
    every range is calendar-aligned to `tz_name`, not a trailing window
    from `now`: `day` (see _day_bucket_starts), `7days` (Monday-Sunday of
    this week - see _week_bucket_starts), `month` (the 1st/8th/15th/22nd of
    this month - see _month_range_bucket_starts), `year` (January-December
    of this year - see _year_bucket_starts)."""
    if range_ == "day":
        return _day_bucket_starts(now, tz_name)
    if range_ == "7days":
        return _week_bucket_starts(now, tz_name)
    if range_ == "month":
        return _month_range_bucket_starts(now, tz_name)
    return _year_bucket_starts(now, tz_name)


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


def _zero_filled_buckets(
    bucket_starts: list[datetime], created_ats: list[datetime]
) -> list[DashboardStatsBucket]:
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
        DashboardStatsBucket(bucketStart=start.isoformat(), count=count)
        for start, count in zip(bucket_starts, counts)
    ]


@router.get("/dashboard/stats")
async def get_dashboard_stats(
    range: DashboardRange, tz: str = "UTC", session: AsyncSession = Depends(get_session)
) -> DashboardStats:
    """Aggregate dashboard stats for the window named by `range` (one of
    "day", "7days", "month", "year" - anything else 422s, enforced by the
    Literal type on the `range` param).

    `tz` is an IANA timezone name (e.g. "Europe/Kyiv", "UTC" - the
    default), consulted for every `range` value to determine "today"/
    "this week"/"this month"/"this year" (see below). A missing, garbled,
    or otherwise unrecognized `tz` falls back to UTC rather than erroring
    the request - this endpoint has never 422'd on anything but the
    `range` Literal itself.

    `totalChunks`/`totalDocuments`/`totalDislikes` are unfiltered counts
    across ALL time (not scoped to `range` at all) - `totalDislikes` in
    particular is deliberately a separate, all-time count from
    `dislikeBuckets` below, which only covers the window `range`/`tz`
    together imply.

    `messageBuckets`/`dislikeBuckets` are built from a single SELECT over
    chat_messages within the window (bucketed in Python, not SQL - see
    _bucket_starts/_bucket_index/_zero_filled_buckets above), each always
    exactly as many buckets as `range` implies, zero-filled where empty -
    every one of them calendar-aligned to `tz`, not a trailing window from
    `now`:
      - day:   24 buckets, 1h wide,  local midnight through local 23:00 of
               "today" in `tz` (see _day_bucket_starts; buckets for hours
               later than the current local time legitimately show count
               0, since today hasn't happened yet)
      - 7days:  7 buckets, 24h wide, Monday through Sunday of "this week"
               in `tz` (see _week_bucket_starts; the whole window only
               advances once local time crosses into the next Monday, not
               one day at a time)
      - month:  4 buckets - the 1st/8th/15th/22nd of "this month" in `tz`
               (see _month_range_bucket_starts; the last bucket runs
               through however many days this month actually has left -
               6 to 9 - not a fixed width)
      - year:  12 buckets, 1 calendar month wide, January through
               December of "this year" in `tz` (see _year_bucket_starts)
    `messageBuckets` counts only role = 'user' rows (a user's own sent
    messages - assistant replies are deliberately excluded, per explicit
    request: this chart is "Messages sent", not "messages exchanged");
    `dislikeBuckets` counts every row where disliked = true regardless of
    role (in practice only ever assistant replies, since there's no UI to
    dislike your own message, but this endpoint doesn't assume that).
    """
    now = datetime.now(timezone.utc)
    bucket_starts = _bucket_starts(range, now, tz)

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
                "SELECT created_at, role, disliked FROM chat_messages "
                "WHERE created_at >= :since"
            ),
            {"since": bucket_starts[0]},
        )
    ).all()

    return DashboardStats(
        # No users table exists yet - auth isn't built in this app. This is
        # a deliberate placeholder, not a bug; it'll need real counting
        # once auth (and a users table) exist.
        totalUsers=0,
        totalChunks=total_chunks,
        totalDocuments=total_documents,
        totalDislikes=total_dislikes,
        messageBuckets=_zero_filled_buckets(
            bucket_starts, [row.created_at for row in rows if row.role == ChatRole.USER]
        ),
        dislikeBuckets=_zero_filled_buckets(
            bucket_starts, [row.created_at for row in rows if row.disliked]
        ),
    )


def _parse_embedding(embedding_text: str) -> list[float]:
    """Parses pgvector's bracketed-CSV text format (e.g. "[0.1,0.2]" - the
    same format `app.chunks.vectors.format_vector` produces on the way in) back
    into a list of floats. Nothing else in this codebase reads a raw
    embedding back out of Postgres - there's no pgvector Python codec
    registered anywhere (see app/db/session.py, a plain SQLAlchemy async engine) -
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


def _chunk_graph_node(row, coordinates: tuple[float, float, float]) -> ChunkGraphNode:
    x, y, z = coordinates
    return ChunkGraphNode(
        id=str(row.id),
        documentId=str(row.document_id),
        filename=row.filename,
        x=x,
        y=y,
        z=z,
        # The chunk's own position within its document (not an index into
        # this response) - lets the frontend chain same-document nodes in
        # reading order (chunk 1 -> chunk 2 -> chunk 3 -> ...) rather than
        # connecting every chunk to every other chunk in the document.
        position=row.position,
    )


@router.get("/dashboard/chunk-graph")
async def get_chunk_graph(session: AsyncSession = Depends(get_session)) -> ChunkGraph:
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

    return ChunkGraph(
        nodes=[
            _chunk_graph_node(row, node_coordinates)
            for row, node_coordinates in zip(rows, coordinates)
        ]
    )


# --- openai spend --------------------------------------------------------
#
# Powers the Dashboard's Stats tab "spent today / this week / this month /
# this year" block, plus (see _bucket_completions_input_tokens/
# _bucket_completions_output_tokens/_bucket_embeddings_tokens/
# _summarize_openai_tokens below) a parallel "tokens used" figure - split
# into input/output - for the same four windows. Deliberately isolated
# from app.chunks.embedding/app.chat.completion: those modules' get_client()/
# embed_texts()/generate_reply() are built around settings.openai_api_key (a
# regular/project key that can make chat and embeddings calls). This feature
# needs settings.openai_admin_api_key instead - a separate, org-level Admin
# key that can read organization usage/billing (GET /organization/costs, GET
# /organization/usage/completions, GET /organization/usage/embeddings) but
# CANNOT make chat/embeddings calls, and vice versa for openai_api_key.
# Both keys are optional and independent; app.chunks.embedding/
# app.chat.completion's client/key handling is untouched by any of the below.

# Rolling-window durations for the four numbers this endpoint reports (for
# both the money and token summaries) - trailing N days from "now", NOT
# calendar-aligned (unlike this file's stats-chart bucket logic above,
# e.g. _year_bucket_starts) - simpler, and sufficient since this is 4
# summary numbers per metric, not a bucketed chart.
_OPENAI_SPEND_WINDOWS: dict[str, timedelta] = {
    "day": timedelta(days=1),
    "week": timedelta(days=7),
    "month": timedelta(days=30),
    "year": timedelta(days=365),
}

# OpenAI's Costs API (client.admin.organization.usage.costs) caps `limit`
# (buckets per page) at 180 - see that method's own docstring in the
# installed SDK's openai/resources/admin/organization/usage.py - so
# covering the full trailing-365-day window this endpoint needs takes more
# than one page; _fetch_openai_usage_buckets below paginates via the
# response's own `next_page` cursor until has_more is false.
_OPENAI_COSTS_PAGE_LIMIT = 180

# The completions/embeddings usage endpoints (client.admin.organization.
# usage.completions/.embeddings) are a different resource from costs above
# and cap `limit` lower for bucket_width="1d" - max 31, per each method's
# own docstring in usage.py ("bucket_width=1d: default: 7, max: 31" - the
# 1h/1m tiers documented alongside it allow higher limits, but this
# endpoint always uses bucket_width="1d", same as costs, for consistency
# and because daily granularity is plenty for day/week/month/year
# rollups).
_OPENAI_USAGE_PAGE_LIMIT = 31

# Kept as plain dicts (day/week/month/year/currency, matching
# OpenAiSpend's own field names minus `tokens`/`configured`) so they can be
# spread straight into an OpenAiSpend(**_ZERO_OPENAI_SPEND, tokens=...,
# configured=...) construction below, the same shape the original dict
# literal this replaced used.
_ZERO_OPENAI_SPEND = {"day": 0.0, "week": 0.0, "month": 0.0, "year": 0.0, "currency": "usd"}
_ZERO_OPENAI_TOKEN_WINDOW = OpenAiSpendTokenWindow(input=0, output=0)
_ZERO_OPENAI_TOKENS = OpenAiSpendTokens(
    day=_ZERO_OPENAI_TOKEN_WINDOW,
    week=_ZERO_OPENAI_TOKEN_WINDOW,
    month=_ZERO_OPENAI_TOKEN_WINDOW,
    year=_ZERO_OPENAI_TOKEN_WINDOW,
)


@lru_cache
def _get_admin_client() -> AsyncOpenAI:
    """Same AsyncOpenAI client class as app.chunks.embedding.get_client(), just a
    different key/instance - built from settings.openai_admin_api_key, not
    settings.openai_api_key. Passed as `admin_api_key=`, NOT `api_key=`:
    the SDK's admin/organization endpoints (client.admin.organization.
    usage.costs/completions/embeddings - see _fetch_openai_spend_buckets/
    _fetch_openai_completions_buckets/_fetch_openai_embeddings_buckets
    below) are declared with `security={"admin_api_key_auth": True}`
    (verified in the installed SDK's
    openai/resources/admin/organization/usage.py) - they build their
    Authorization header from `self.admin_api_key` specifically, and
    ignore `self.api_key` entirely. Passing the key as `api_key=` (an
    earlier bug here) left `self.admin_api_key` unset, so every one of
    those three calls raised "Could not resolve authentication method"
    (a TypeError, not an OpenAI API error) - caught by get_openai_spend's
    try/except and silently zeroed, even though `configured` came back
    `true` and the key itself was perfectly valid. lru_cache'd for the
    same reason app.chunks.embedding.get_client() is: reused across requests within a
    process rather than reconstructed (and its underlying httpx
    connection pool rebuilt) on every call."""
    return AsyncOpenAI(admin_api_key=get_settings().openai_admin_api_key)


async def _fetch_openai_usage_buckets(
    method: Callable[..., Awaitable], since: datetime, limit: int
) -> list:
    """Shared pagination loop underlying every OpenAI organization-usage
    fetcher below (costs/completions/embeddings, see
    _fetch_openai_spend_buckets/_fetch_openai_completions_buckets/
    _fetch_openai_embeddings_buckets) - all three of
    client.admin.organization.usage.{costs,completions,embeddings} share
    an identical request/pagination shape (start_time, bucket_width="1d",
    limit, page -> response.data/has_more/next_page), differing only in
    which bound SDK method is called and that method's own per-page
    `limit` cap (`_OPENAI_COSTS_PAGE_LIMIT` vs `_OPENAI_USAGE_PAGE_LIMIT`
    above). Paginates via `next_page` until has_more is false. Raises
    whatever the SDK raises on failure (bad key, network error, rate
    limit, ...) - get_openai_spend below is responsible for catching that,
    not this function.
    """
    buckets: list = []
    page: str | None = None
    while True:
        kwargs = {
            "start_time": int(since.timestamp()),
            "bucket_width": "1d",
            "limit": limit,
        }
        if page:
            kwargs["page"] = page
        response = await method(**kwargs)
        buckets.extend(response.data)
        if not response.has_more or not response.next_page:
            break
        page = response.next_page
    return buckets


async def _fetch_openai_spend_buckets(since: datetime) -> list:
    """Fetches every daily OpenAI organization cost bucket from `since`
    through now, via client.admin.organization.usage.costs (bucket_width
    only supports "1d", per the SDK's own docstring on that method) - see
    _fetch_openai_usage_buckets above for the shared pagination shape.

    A thin, single-purpose external-boundary function - patched directly
    in tests (`app.dashboard.router._fetch_openai_spend_buckets`) the
    same way app/chat/router.py's tests patch
    app.chat.router.embed_texts/generate_reply, rather than mocked at the
    raw SDK client level.
    """
    client = _get_admin_client()
    return await _fetch_openai_usage_buckets(
        client.admin.organization.usage.costs, since, _OPENAI_COSTS_PAGE_LIMIT
    )


async def _fetch_openai_completions_buckets(since: datetime) -> list:
    """Fetches every daily OpenAI organization completions-usage bucket
    from `since` through now, via
    client.admin.organization.usage.completions. Each bucket's `results`
    are DataResultOrganizationUsageCompletionsResult entries (object ==
    "organization.usage.completions.result", per the installed SDK's
    usage_completions_response.py) carrying `input_tokens`/`output_tokens`
    - see _bucket_completions_input_tokens/_bucket_completions_output_tokens
    below for how those are summed.

    Same thin, directly-patchable external-boundary convention as
    _fetch_openai_spend_buckets above (patched in tests as
    `app.dashboard.router._fetch_openai_completions_buckets`).
    """
    client = _get_admin_client()
    return await _fetch_openai_usage_buckets(
        client.admin.organization.usage.completions, since, _OPENAI_USAGE_PAGE_LIMIT
    )


async def _fetch_openai_embeddings_buckets(since: datetime) -> list:
    """Fetches every daily OpenAI organization embeddings-usage bucket
    from `since` through now, via
    client.admin.organization.usage.embeddings. Each bucket's `results`
    are DataResultOrganizationUsageEmbeddingsResult entries (object ==
    "organization.usage.embeddings.result", per the installed SDK's
    usage_embeddings_response.py) carrying `input_tokens` only - embeddings
    have no output-token concept - see _bucket_embeddings_tokens below.

    Same thin, directly-patchable external-boundary convention as
    _fetch_openai_spend_buckets above (patched in tests as
    `app.dashboard.router._fetch_openai_embeddings_buckets`).
    """
    client = _get_admin_client()
    return await _fetch_openai_usage_buckets(
        client.admin.organization.usage.embeddings, since, _OPENAI_USAGE_PAGE_LIMIT
    )


def _bucket_spend_amount(bucket) -> tuple[float, str | None]:
    """One cost bucket's total spend as (amount, currency). `bucket.results`
    is always a list (OpenAI's Costs API supports group_by, which this
    endpoint never uses, but the response shape is a list regardless - see
    DataResultOrganizationCostsResult in the installed SDK's
    usage_costs_response.py) - so every result in the bucket is summed,
    not just a first/only one. `currency` is None when the bucket has no
    results to read one from - the documented shape for a zero-spend
    bucket (`"results": []`), verified live against a real $0-spend
    account."""
    total = 0.0
    currency: str | None = None
    for result in bucket.results:
        amount = getattr(result, "amount", None)
        if amount is None:
            continue
        if amount.value is not None:
            total += amount.value
        if currency is None and amount.currency:
            currency = amount.currency
    return total, currency


def _windows_containing(bucket, now: datetime) -> list[str]:
    """Which of _OPENAI_SPEND_WINDOWS' rolling windows `bucket` counts
    toward, as of `now` - shared by _summarize_openai_spend (cost buckets)
    and _sum_tokens_into_windows (token buckets) below, whose per-bucket
    accumulation otherwise differs (a dollar amount + currency vs. a token
    count) but whose "which windows does this bucket belong to" rule is
    identical - previously duplicated in both functions' loops."""
    bucket_start = datetime.fromtimestamp(bucket.start_time, tz=timezone.utc)
    return [
        window
        for window, duration in _OPENAI_SPEND_WINDOWS.items()
        if bucket_start >= now - duration
    ]


def _summarize_openai_spend(buckets: list, now: datetime) -> dict:
    """Sums `buckets` (one entry per daily OpenAI cost bucket, any order)
    into the four rolling-window totals GET /internal/dashboard/openai-spend
    reports - {"day", "week", "month", "year", "currency"} (the caller adds
    "configured" separately). Each of the four is an independent sum over
    its own trailing window from `now` (1/7/30/365 days respectively) -
    NOT a running/cumulative single pass, so e.g. "day"'s total is not
    added again on top of "week"'s (which already covers the trailing 7
    days, including today, by itself). A bucket counts toward a window if
    its start falls within that window's trailing duration of `now`;
    since OpenAI's cost buckets are calendar-day-aligned (UTC midnight to
    midnight, per the live-verified response shape), in practice this
    means exactly one bucket (today's, still in progress) ever satisfies
    "day".

    `currency` is read off the first bucket result with a non-None
    currency (every result is expected to share the same one); falls back
    to "usd" if there was no spend anywhere in `buckets` to read a
    currency from at all, so an all-zero account still renders as "$0.00"
    rather than an empty/missing currency.
    """
    totals = {window: 0.0 for window in _OPENAI_SPEND_WINDOWS}
    currency: str | None = None
    for bucket in buckets:
        amount, bucket_currency = _bucket_spend_amount(bucket)
        if currency is None and bucket_currency:
            currency = bucket_currency
        for window in _windows_containing(bucket, now):
            totals[window] += amount
    return {**totals, "currency": currency or "usd"}


def _bucket_completions_input_tokens(bucket) -> int:
    """One completions-usage bucket's total input_tokens, summed across
    every result in `bucket.results` (always a list - same
    group_by-agnostic shape as _bucket_spend_amount above). Non-optional on
    DataResultOrganizationUsageCompletionsResult (see
    usage_completions_response.py), but `getattr(..., 0)` is used anyway
    to fail safe rather than raise if a future SDK/API response ever
    omits it."""
    return sum(getattr(result, "input_tokens", 0) for result in bucket.results)


def _bucket_completions_output_tokens(bucket) -> int:
    """One completions-usage bucket's total output_tokens, summed across
    every result in `bucket.results` (always a list - same
    group_by-agnostic shape as _bucket_spend_amount above). Non-optional on
    DataResultOrganizationUsageCompletionsResult (see
    usage_completions_response.py), but `getattr(..., 0)` is used anyway
    to fail safe rather than raise if a future SDK/API response ever
    omits it."""
    return sum(getattr(result, "output_tokens", 0) for result in bucket.results)


def _bucket_embeddings_tokens(bucket) -> int:
    """One embeddings-usage bucket's total token count: input_tokens
    summed across every result in `bucket.results` - embeddings have no
    output_tokens concept (see DataResultOrganizationUsageEmbeddingsResult
    in usage_embeddings_response.py), unlike completions above."""
    return sum(getattr(result, "input_tokens", 0) for result in bucket.results)


def _sum_tokens_into_windows(
    buckets: list, now: datetime, tokens_per_bucket: Callable[[object], int]
) -> dict[str, int]:
    """Sums `tokens_per_bucket(bucket)` (one of
    _bucket_completions_input_tokens/_bucket_completions_output_tokens/
    _bucket_embeddings_tokens above) across `buckets` into the same four
    independent rolling-window totals _summarize_openai_spend computes for
    cost buckets - see that function's docstring for exactly how a bucket
    is assigned to a window (the assignment rule is identical here; only
    the per-bucket amount extracted differs: a token count instead of a
    dollar amount, and no currency to track). Shared by
    _summarize_openai_tokens below for its completions-input,
    completions-output, and embeddings-input passes.
    """
    totals = {window: 0 for window in _OPENAI_SPEND_WINDOWS}
    for bucket in buckets:
        tokens = tokens_per_bucket(bucket)
        for window in _windows_containing(bucket, now):
            totals[window] += tokens
    return totals


def _summarize_openai_tokens(
    completions_buckets: list, embeddings_buckets: list, now: datetime
) -> dict[str, dict[str, int]]:
    """Combines completions buckets (input_tokens and output_tokens
    separately) and embeddings buckets (input_tokens only - embeddings have
    no output-token concept) into the {"day", "week", "month", "year"}
    `tokens` dict GET /internal/dashboard/openai-spend reports alongside its
    existing USD fields, each window now an {"input": int, "output": int}
    pair rather than one combined total. DocuMind only ever calls OpenAI for
    chat completions (see app.chat.completion) and embeddings (see
    app.chunks.embedding): "input" per window is
    completions input_tokens plus embeddings input_tokens (embeddings only
    ever contribute to "input"); "output" per window is completions
    output_tokens alone. Each of the three underlying sums (completions
    input, completions output, embeddings input) is computed independently
    per window (via _sum_tokens_into_windows), NOT one cumulative running
    total across windows (same independent-per-window convention as
    _summarize_openai_spend above) - that independence applies separately
    to "input" and to "output".
    """
    completions_input = _sum_tokens_into_windows(
        completions_buckets, now, _bucket_completions_input_tokens
    )
    completions_output = _sum_tokens_into_windows(
        completions_buckets, now, _bucket_completions_output_tokens
    )
    embeddings_input = _sum_tokens_into_windows(
        embeddings_buckets, now, _bucket_embeddings_tokens
    )
    return {
        window: {
            "input": completions_input[window] + embeddings_input[window],
            "output": completions_output[window],
        }
        for window in _OPENAI_SPEND_WINDOWS
    }


@router.get("/dashboard/openai-spend")
async def get_openai_spend() -> OpenAiSpend:
    """Rolling-window OpenAI organization spend + token-usage summary for
    the Dashboard's Stats tab "spent today / this week / this month / this
    year" block:

        {"day": 0.42, "week": 3.10, "month": 12.55, "year": 87.20,
         "tokens": {
             "day": {"input": 800, "output": 400},
             "week": {"input": 5600, "output": 2800},
             "month": {"input": 23000, "output": 12000},
             "year": {"input": 270000, "output": 140000},
         },
         "currency": "usd", "configured": true}

    day/week/month/year are trailing rolling-window USD totals (see
    _summarize_openai_spend for exactly how a bucket is assigned to a
    window). `tokens` is the same four rolling windows, but each an
    {"input": int, "output": int} pair instead of a dollar amount -
    "input" is completions input_tokens plus embeddings input_tokens,
    "output" is completions output_tokens alone (embeddings have no
    output-token concept) - see _summarize_openai_tokens.
    DocuMind's only two OpenAI call types (app.chunks.embedding/
    app.chat.completion).

    `configured` is false (with all four amounts and all four token counts
    zeroed, currency "usd") when settings.openai_admin_api_key is empty -
    this whole feature is optional, same "gracefully does nothing without
    it" convention as OPENAI_API_KEY itself (see .env.example's own
    comment on that key). No OpenAI call is even attempted in that case.

    `configured` is still true, but every amount AND every token count is
    zeroed the same way, if the key IS set but ANY of the three OpenAI
    calls this endpoint makes (costs, completions, embeddings) fails for
    any reason (bad key, network error, rate limit, unexpected response
    shape, ...) - logged via logger.exception, never allowed to 500 this
    endpoint (or take down the rest of the Stats tab). This is a
    deliberate all-or-nothing choice, not a per-field one: a dashboard
    showing correct dollars alongside zeroed (or vice versa, correct
    tokens alongside zeroed dollars) tokens would look like a bug rather
    than a degraded-but-honest state, so any partial failure across the
    three calls zeroes the whole response rather than just the piece that
    failed. The three calls are made concurrently (via asyncio.gather)
    since they're independent reads over the same trailing window.
    """
    if not get_settings().openai_admin_api_key:
        return OpenAiSpend(**_ZERO_OPENAI_SPEND, tokens=_ZERO_OPENAI_TOKENS, configured=False)

    now = datetime.now(timezone.utc)
    since = now - _OPENAI_SPEND_WINDOWS["year"]
    try:
        cost_buckets, completions_buckets, embeddings_buckets = await asyncio.gather(
            _fetch_openai_spend_buckets(since),
            _fetch_openai_completions_buckets(since),
            _fetch_openai_embeddings_buckets(since),
        )
    except Exception:
        logger.exception("Failed to fetch OpenAI organization usage")
        return OpenAiSpend(**_ZERO_OPENAI_SPEND, tokens=_ZERO_OPENAI_TOKENS, configured=True)

    tokens = _summarize_openai_tokens(completions_buckets, embeddings_buckets, now)
    return OpenAiSpend(
        **_summarize_openai_spend(cost_buckets, now),
        tokens=OpenAiSpendTokens(**tokens),
        configured=True,
    )
