# Improvements Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an "Improvements" sidebar page showing two removable,
time-filterable lists (disliked replies, questions the assistant said
weren't covered by the documentation) plus an inert placeholder second
tab, per `.claude/specs/improvements-page.md`.

**Architecture:** Backend: a marker token (`[[NO_ANSWER]]`) the system
prompt tells the model to prefix its reply with whenever it's giving
rule 4's "not in the documentation" answer; `chat/completion.py` strips it
and returns a `no_answer_found` flag alongside the cleaned reply text,
which `chat/router.py::send_message` persists on the assistant's
`chat_messages` row. That row also gets a `question_id` FK back to the
user message that prompted it (send_message already has both ids in one
request) so both new list endpoints can show the original question, not
just the boilerplate reply. `dislike_message` now stamps `disliked_at`
on toggle-on and clears it on toggle-off, giving the Dislikes list its
own time axis independent of when the underlying message was first sent.
Frontend: a new `ImprovementsPage.tsx` reusing the exact Stats/Logs
sub-tab toggle already built in `DashboardPage.tsx` (extracted into a
shared component first, since duplicating it verbatim would repeat the
same DRY mistake already fixed once this session), two Table-based list
panels each with their own 1-day/7-days/30-days/all-time filter, and a
placeholder second tab.

**Tech Stack:** FastAPI/SQLAlchemy Core (backend, existing patterns
throughout), React/Mantine/TypeScript (frontend, existing patterns
throughout) - no new dependencies.

---

## Key design decisions (read before starting)

- **`no_answer_found` and `disliked_at` are the only new leaf columns** -
  no per-user attribution (explicitly out of scope per the spec's
  Non-Goals). `question_id` is a nullable self-referencing FK on
  `chat_messages`, populated only on assistant rows, pointing at the user
  row that prompted them - this is what lets both new list endpoints show
  "what was actually asked," not just the assistant's own (often
  near-identical) decline text.
- **Removing an entry never deletes the underlying chat_messages row** -
  removing from Dislikes calls the *existing* toggle endpoint
  (`POST /chat/messages/{id}/dislike`, unchanged) to flip `disliked` back
  to false; removing from "No Answer" calls a *new* dismiss endpoint that
  only clears `no_answer_found`. Both leave the message itself intact in
  ordinary Chat history.
- **The marker token is a hidden signal, never shown to the user** - the
  backend strips it before the reply text ever reaches `chat_messages
  .content` or the HTTP response body. It never appears in the UI, in
  tests' assertions on visible content, or in the dashboard - only
  `no_answer_found` (a plain boolean) survives past `chat/completion.py`.
- **`SegmentedToggle`/`TabButton` move out of `DashboardPage.tsx`** into
  a new shared component file - `ImprovementsPage.tsx` needs the exact
  same two-way-toggle look for both its own sub-tab switch and its two
  per-list time-range filters, and duplicating that component a second
  time repeats the exact kind of duplication already flagged and fixed
  once this session (see `app/documents/router.py`'s `upload_document`
  fix earlier today).

---

### Task 1: Migration - no_answer_found, disliked_at, question_id

**Files:**
- Create: `backend/alembic/versions/0007_chat_messages_improvements.py`
- Reference: `backend/alembic/versions/0006_documents_file_size.py`
  (style/header to match - head is currently `0006`)

**Contracts:**

```python
def upgrade() -> None:
    op.add_column(
        "chat_messages",
        sa.Column("no_answer_found", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "chat_messages",
        sa.Column("disliked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "chat_messages",
        sa.Column(
            "question_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("chat_messages.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("chat_messages", "question_id")
    op.drop_column("chat_messages", "disliked_at")
    op.drop_column("chat_messages", "no_answer_found")
```

`question_id` self-references the same table - only ever set on an
assistant-role row, pointing at the user-role row that prompted it;
always `NULL` on user-role rows.

**Step 1: Apply and verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_schema.py -v`
(existing schema tests shouldn't reference these new columns yet, so this
is really just confirming nothing else broke - the real verification is
Task 2's migration-driven test DB picking this up automatically, same as
every earlier migration this session).

**Step 2: Commit**

```bash
git add backend/alembic/versions/0007_chat_messages_improvements.py
git commit -m "feat(chat): add no_answer_found, disliked_at, question_id columns"
```

---

### Task 2: Marker-based no-answer detection

**Files:**
- Modify: `backend/app/chat/completion.py`
- Modify: `backend/app/chat/prompts/chat_system_prompt.txt`
- Test: `backend/tests/test_llm.py`

**Contracts:**

```python
# backend/app/chat/completion.py
from dataclasses import dataclass

# Hidden signal only - never shown to a user, always stripped before the
# reply text is persisted or returned. Must be something a normal answer
# would never start with by coincidence.
NO_ANSWER_MARKER = "[[NO_ANSWER]]"


@dataclass(frozen=True)
class GeneratedReply:
    content: str
    no_answer_found: bool


async def generate_reply(
    user_message: str, context_chunks: list[str], client: AsyncOpenAI | None = None
) -> GeneratedReply:
    """Same call/error contract as before (LLMError on any SDK failure or
    empty/None content), now returns GeneratedReply instead of a bare
    str - see _parse_reply for how the marker is detected/stripped."""
    ...


def _parse_reply(raw_content: str) -> GeneratedReply:
    """If raw_content starts with NO_ANSWER_MARKER, strips it (and any
    leading whitespace/newline right after it) and returns
    GeneratedReply(content=<stripped>, no_answer_found=True). Otherwise
    returns GeneratedReply(content=raw_content, no_answer_found=False)
    unchanged."""
    ...
```

Update `chat_system_prompt.txt`: add a new rule (after the existing
formatting rule 6) instructing the model that whenever rule 4's "answer
isn't in the documentation" response applies, it must prefix its ENTIRE
reply with the exact literal text `[[NO_ANSWER]]` (matching
`NO_ANSWER_MARKER` above byte-for-byte) followed by a space, before
anything else - and that this prefix is a hidden internal signal, never
something the user should see explained or referenced. State plainly
that this prefix rule applies only to that one specific case (rule 4's
"not in the documentation" answer), never to rule 2's security-decline
or any ordinary reply.

**Step 1: Write the failing test**

`test_llm.py`: extend the existing `generate_reply` tests (they currently
assert a plain string return - see `_make_chat_response` helper) since
the return type changes:
- A completion response starting with `"[[NO_ANSWER]] I'm sorry..."` ->
  `generate_reply(...)` returns a `GeneratedReply` with
  `no_answer_found=True` and `content` equal to the text AFTER the
  marker and its following whitespace (marker itself NOT present in
  `.content`).
- An ordinary completion response (no marker) -> `no_answer_found=False`,
  `.content` unchanged from what the SDK returned.
- Existing "system prompt includes house rules" tests
  (`test_generate_reply_system_prompt_includes_house_rules_with_context`/
  `..._with_empty_context`) - now need `.content` (not the bare return
  value) wherever they read the reply text, but their system-prompt-text
  assertions are unaffected. Also add an assertion that the system prompt
  content includes the marker text `[[NO_ANSWER]]` somewhere (confirms
  the new prompt rule actually made it into `CHAT_SYSTEM_PROMPT`).
- Direct `_parse_reply` unit tests: marker + leading space stripped
  correctly; marker with a newline after it also stripped correctly; no
  marker -> passed through unchanged; a normal reply that merely
  *mentions* "[[NO_ANSWER]]" somewhere in the middle (not at the very
  start) -> `no_answer_found=False` (only a literal prefix counts).

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_llm.py -v`
Expected: FAIL (return type doesn't exist yet)

**Step 2: Implement**

Implement per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_llm.py -v`
Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/chat/completion.py backend/app/chat/prompts/chat_system_prompt.txt backend/tests/test_llm.py
git commit -m "feat(chat): detect the assistant's own no-answer replies via a stripped marker"
```

---

### Task 3: Wire into chat/router.py - send_message, dislike, new list/dismiss endpoints

**Files:**
- Modify: `backend/app/chat/router.py`
- Modify: `backend/app/chat/schemas.py`
- Test: `backend/tests/test_chat_router.py`
- Reference: `backend/app/dashboard_events/router.py` (pattern for a
  `GET` list endpoint with a time-range query param -
  `dashboard/router.py`'s `get_dashboard_stats` also has a range param,
  check both for the closest existing shape)

**Contracts:**

```python
# backend/app/chat/schemas.py - add
from typing import Literal

ImprovementsRange = Literal["day", "7days", "30days", "all"]


class DislikedMessageSummary(BaseModel):
    id: str
    content: str
    questionContent: str | None  # None only if question_id somehow didn't resolve (shouldn't happen in practice, but the FK is nullable)
    dislikedAt: str
    createdAt: str


class NoAnswerMessageSummary(BaseModel):
    id: str
    content: str
    questionContent: str | None
    createdAt: str
```

```python
# backend/app/chat/router.py

@router.post("/chat/messages")
async def send_message(...) -> ChatMessageSummary:
    """Same contract as before, plus: the assistant INSERT now also
    writes `question_id` (the user row's own id, inserted earlier in
    this same function) and `no_answer_found` (from generate_reply's
    returned GeneratedReply.no_answer_found). `reply.content` (not the
    old bare string) is what gets persisted/returned - the marker,
    if any, was already stripped by generate_reply."""
    ...


@router.post("/chat/messages/{message_id}/dislike", status_code=204)
async def dislike_message(...) -> None:
    """Same toggle contract as before, plus: stamps `disliked_at = now()`
    when flipping to disliked=true, clears it to NULL when flipping back
    to false - single UPDATE, same statement shape as today (see the
    CASE expression note in the plan's design-decisions section above:
    both `disliked = NOT disliked` and the disliked_at CASE read the
    OLD row value, Postgres evaluates a single UPDATE's SET list against
    the pre-update row throughout)."""
    ...


@router.get("/chat/dislikes")
async def list_disliked_messages(
    range: ImprovementsRange, session: AsyncSession = Depends(get_session)
) -> list[DislikedMessageSummary]:
    """Every message with disliked=true and disliked_at within `range`
    (day/7days/30days back from now, or no lower bound at all for
    "all"), newest disliked_at first. LEFT JOINs each row's own
    question_id back to that user message's content for questionContent
    (NULL if question_id itself is NULL)."""
    ...


@router.get("/chat/no-answer-messages")
async def list_no_answer_messages(
    range: ImprovementsRange, session: AsyncSession = Depends(get_session)
) -> list[NoAnswerMessageSummary]:
    """Every message with no_answer_found=true and created_at within
    `range`, newest created_at first. Same question_id LEFT JOIN as
    list_disliked_messages above."""
    ...


@router.post("/chat/messages/{message_id}/dismiss-no-answer", status_code=204)
async def dismiss_no_answer(
    message_id: UUID, session: AsyncSession = Depends(get_session)
) -> None:
    """UPDATE chat_messages SET no_answer_found = false WHERE id = :id -
    one-way (not a toggle, unlike dislike_message - there's no UI path
    that re-flags a message as no_answer_found, only the assistant's own
    generation step ever sets it true). Same idempotent-204-even-if-
    missing-id contract as dislike_message."""
    ...
```

**Integration:**
- `range` -> a SQL `WHERE disliked_at >= :cutoff` (or `created_at >=
  :cutoff` for the no-answer list) built from `range`, or no WHERE clause
  at all for `"all"` - compute `cutoff` in Python
  (`datetime.now(timezone.utc) - timedelta(days=1|7|30)`) and pass it as
  a bound param when `range != "all"`, matching this codebase's bound-
  param-only convention (no string-built SQL).
- FastAPI query param: `range: ImprovementsRange` as a plain
  `Depends`-free query parameter (FastAPI infers it from the function
  signature for a GET route, same as other query-param endpoints already
  in this codebase - check `dashboard/router.py`'s stats endpoint for the
  closest existing pattern of a required/typed query param).

**Step 1: Write the failing tests**

`test_chat_router.py` - follow the existing dislike/send_message test
patterns in this file closely (fixtures, `authenticated_client`,
cleanup helpers):
- Sending a message, then GET `/chat/dislikes?range=all` before disliking
  -> empty list; after disliking via the existing dislike endpoint -> the
  message appears, with `dislikedAt` set and `questionContent` equal to
  the original user message's content.
- Un-disliking (calling dislike again) -> the message drops out of
  `/chat/dislikes?range=all`; `disliked_at` cleared (assert via a direct
  DB read, same `SyncSessionLocal`-based helper pattern this file's
  existing tests already use).
- A response containing the `[[NO_ANSWER]]` marker (mock `generate_reply`
  the same way existing tests already do, e.g. via `AsyncMock`) -> the
  resulting assistant message has `no_answer_found=True` in the DB, and
  it appears in GET `/chat/no-answer-messages?range=all` with
  `questionContent` equal to the user's own message content and the
  marker NOT present anywhere in the returned `content`.
- Calling `/chat/messages/{id}/dismiss-no-answer` -> the message drops
  out of `/chat/no-answer-messages?range=all`; the message itself is
  still returned by ordinary `GET /chat/messages`.
- `range` filtering: seed (via direct DB inserts, backdating
  `disliked_at`/`created_at` with an explicit timestamp - same
  `_force_status`-style direct-SQL helper idiom other test files in this
  project use for backdating) one entry inside the last day, one outside
  30 days but within "all" - assert `range=day` excludes the old one,
  `range=all` includes both.
- Both new list endpoints require a session cookie (401 without one) -
  same one-line pattern as this file's existing
  `test_list_documents_without_session_cookie_returns_401`-style tests
  elsewhere in this project (check `test_documents_router.py` for the
  exact idiom).

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_chat_router.py -v`
Expected: FAIL

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_chat_router.py -v`
Expected: PASS. Then run the full suite: `.venv/Scripts/python.exe -m pytest tests/ -q` and confirm no regressions (the 3 tests in this same file that check "zero ready documents" behavior, and the one flaky UMAP determinism test in test_dashboard_router.py, are pre-existing/unrelated - see this session's earlier notes if either shows up).

**Step 4: Commit**

```bash
git add backend/app/chat/router.py backend/app/chat/schemas.py backend/tests/test_chat_router.py
git commit -m "feat(chat): dislikes/no-answer list endpoints, question linking, dismiss action"
```

---

### Task 4: Frontend API client - types, methods, mock data

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/api/httpClient.ts`
- Modify: `frontend/src/api/mockClient.ts`
- Test: `frontend/src/api/httpClient.test.ts`

**Contracts:**

```typescript
// frontend/src/api/types.ts - add
export type ImprovementsRange = 'day' | '7days' | '30days' | 'all'

export interface DislikedMessage {
  id: string
  content: string
  questionContent: string | null
  dislikedAt: string
  createdAt: string
}

export interface NoAnswerMessage {
  id: string
  content: string
  questionContent: string | null
  createdAt: string
}
```

```typescript
// frontend/src/api/client.ts - add to ApiClient interface
getDislikedMessages(range: ImprovementsRange): Promise<DislikedMessage[]>
getNoAnswerMessages(range: ImprovementsRange): Promise<NoAnswerMessage[]>
dismissNoAnswerMessage(messageId: string): Promise<void>
// dislikeMessage(messageId) already exists - reused as-is for "remove from Dislikes"
```

`httpClient.ts`: `getDislikedMessages`/`getNoAnswerMessages` GET
`/internal/chat/dislikes`/`/internal/chat/no-answer-messages` with `range`
as a URL query param (follow `getDashboardStats`'s existing
query-param-building pattern in this same file for the exact idiom -
URL-encode the value the same way). `dismissNoAnswerMessage` POSTs
`/internal/chat/messages/{messageId}/dismiss-no-answer`, same shape as
the existing `dislikeMessage` method right above it.

`mockClient.ts`: seed a small in-memory `dislikedMessages`/
`noAnswerMessages`-equivalent (or derive them by filtering the existing
`chatMessages` array plus a couple of new seeded rows with the relevant
flags) - follow this file's existing seed-data + array-mutation
conventions (see how `dashboardEvents`/`documents` are seeded and mutated
elsewhere in this file).

**Step 1: Write the failing test**

`httpClient.test.ts`: follow the existing `getDashboardStats`/
`dislikeMessage` test patterns in this file - assert
`getDislikedMessages('7days')` GETs `/internal/chat/dislikes?range=7days`
and returns the parsed array; same shape for
`getNoAnswerMessages`/`dismissNoAnswerMessage`.

Run: `cd frontend && npx vitest run src/api/httpClient.test.ts`
Expected: FAIL

**Step 2: Implement**

Per the contracts above.

**Step 3: Verify**

Run: `cd frontend && npx vitest run src/api/httpClient.test.ts` and
`npx tsc -b` (typecheck - `mockApiClient` must still satisfy the
`ApiClient` interface once the new methods are added to it).
Expected: PASS, no type errors.

**Step 4: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/api/httpClient.ts frontend/src/api/mockClient.ts frontend/src/api/httpClient.test.ts
git commit -m "feat(chat): add Improvements-page API client methods"
```

---

### Task 5: Extract SegmentedToggle into a shared component

**Files:**
- Create: `frontend/src/components/SegmentedToggle.tsx`
- Modify: `frontend/src/pages/DashboardPage.tsx`
- Test: `frontend/src/pages/DashboardPage.test.tsx` (should need no
  changes if the extraction preserves behavior exactly - run it to
  confirm)

**Contracts:**

Move `TabButtonProps`, `TabButton`, `SegmentedToggleProps<T>`,
`SegmentedToggle<T>` (currently `DashboardPage.tsx` lines ~39-106, see
this plan's own research) verbatim into the new file, exported. Update
`DashboardPage.tsx` to `import { SegmentedToggle } from
'../components/SegmentedToggle'` and delete its own local copies of all
four. No behavior change - this is a pure extraction.

**Step 1: Extract**

Move the code, update the import, delete the now-dead local
definitions.

**Step 2: Verify**

Run: `cd frontend && npx vitest run src/pages/DashboardPage.test.tsx`
Expected: PASS, unchanged (this is a refactor - if any assertion breaks,
the extraction changed behavior, which it shouldn't have).
Run: `npx tsc -b` - confirm no type errors from the move.

**Step 3: Commit**

```bash
git add frontend/src/components/SegmentedToggle.tsx frontend/src/pages/DashboardPage.tsx
git commit -m "refactor(dashboard): extract SegmentedToggle into a shared component"
```

---

### Task 6: ImprovementsPage - sidebar entry, route, both sub-tabs

**Files:**
- Create: `frontend/src/pages/ImprovementsPage.tsx`
- Create: `frontend/src/pages/ImprovementsPage.module.css` (only if
  needed beyond what inline styles + existing shared classes cover -
  check `DashboardPage.module.css`/`UploadPage`'s own styling approach
  first)
- Test: `frontend/src/pages/ImprovementsPage.test.tsx`
- Modify: `frontend/src/layout/AppLayout.tsx`
- Modify: `frontend/src/App.tsx`
- Reference: `frontend/src/pages/DashboardPage.tsx` (Stats/Logs toggle +
  Logs tab's Table-based list with a time-range filter is the closest
  existing pattern for everything in this task - follow its structure:
  tab-persistence-via-localStorage idiom, `SegmentedToggle` usage,
  `Table`/`Table.Thead`/`Table.Tbody` shape, empty-state message,
  pagination if the list can be long - but a per-list *remove* action
  is new, model it on `UploadPage.tsx`'s delete `ActionIcon` +
  confirmation pattern)

**Contracts:**

```typescript
// frontend/src/layout/AppLayout.tsx - add to the existing nav items array
{ to: '/improvements', label: 'Improvements' },
```

```typescript
// frontend/src/App.tsx - add inside the existing nested <Routes>
<Route path="/improvements" element={<ImprovementsPage />} />
```

```typescript
// frontend/src/pages/ImprovementsPage.tsx
type ImprovementsTab = 'lists' | 'analysis'  // sub-tab 1 / sub-tab 2 - name these however reads best, no fixed contract on the literal string values

export function ImprovementsPage(): JSX.Element {
  // Tab persistence: same loadActiveTab/saveActiveTab-to-localStorage
  // idiom as DashboardPage.tsx's own Stats/Logs tab (own storage key,
  // e.g. 'documind:improvements:activeTab' - don't collide with
  // DashboardPage's own key).
  ...
}
```

Sub-tab 1 ("lists"): two panels, Dislikes and No Answer, each with:
- Its own `SegmentedToggle<ImprovementsRange>` (Day / 7 Days / 30 Days /
  All time labels) driving a fetch of that panel's own list via the
  Task 4 API methods.
- A `Table` (or equivalent) with columns for the question, the reply/
  detail, when (dislikedAt or createdAt as appropriate), and an Actions
  column with a remove `ActionIcon` per row.
- Removing a row: Dislikes panel calls `apiClient.dislikeMessage(id)`
  (same endpoint Chat's own dislike button uses - toggles it off since
  it's already disliked); No Answer panel calls
  `apiClient.dismissNoAnswerMessage(id)`. Either way, remove the row from
  local state immediately (optimistic - same pattern
  `UploadPage.tsx`'s delete flow already uses) rather than waiting on a
  full refetch.
- Empty-state message per panel when its list is empty for the current
  range (same style as `UploadPage.tsx`/`DashboardPage.tsx`'s own
  "No documents..."/"No matching entries..." empty states).

Sub-tab 2 ("analysis"): a page shell (`Paper`/`Stack`, matching this
app's established page-shell look) containing a `Title` and one
`Button` ("Analyze with AI" or similar - exact copy is your call) with
**no `onClick` handler that does anything** - either omit `onClick`
entirely or give it a no-op, and consider `disabled` so it visibly reads
as "not wired up yet" rather than a button that silently does nothing
when clicked. No API call, no state.

**Step 1: Write the failing tests**

`ImprovementsPage.test.tsx` - follow `DashboardPage.test.tsx`'s own
testing patterns closely (stub global `fetch`, same
`renderWithProviders`/`screen` idiom):
- Page renders with the sub-tab toggle, defaulting to sub-tab 1.
- Sub-tab 1 shows both panels' seeded entries (mock fetch responses for
  both endpoints).
- Clicking a panel's own time-range option refetches that panel's list
  with the right `range` query param (assert on the `fetch` call args).
- Clicking a row's remove action in the Dislikes panel calls the dislike
  endpoint and removes that row from view; same for No Answer's dismiss
  endpoint.
- An empty list (for the current range) shows the empty-state message
  instead of an empty table.
- Switching to sub-tab 2 shows the placeholder button; clicking it fires
  no network request (assert `fetch` call count unchanged before/after
  the click).
- "Improvements" appears in the sidebar (`AppLayout.test.tsx` - add one
  assertion there, following its existing per-nav-item test pattern) and
  navigates to `/improvements`.

Run: `cd frontend && npx vitest run src/pages/ImprovementsPage.test.tsx src/layout/AppLayout.test.tsx`
Expected: FAIL

**Step 2: Implement**

Per the contracts above, following the referenced existing patterns.

**Step 3: Verify**

Run: `cd frontend && npx vitest run` (full suite) and `npx tsc -b`.
Expected: PASS, no regressions, no type errors.

**Step 4: Commit**

```bash
git add frontend/src/pages/ImprovementsPage.tsx frontend/src/pages/ImprovementsPage.test.tsx frontend/src/layout/AppLayout.tsx frontend/src/layout/AppLayout.test.tsx frontend/src/App.tsx
git commit -m "feat(chat): add Improvements page - dislikes/no-answer lists + placeholder analysis tab"
```

(Add `frontend/src/pages/ImprovementsPage.module.css` too if Task 6
ended up needing one.)

---

### Task 7: Full regression + live smoke test

**Files:** None new - verification only.

**Step 1:** `cd backend && .venv/Scripts/python.exe -m pytest tests/ -q`
- PASS (only the known pre-existing/unrelated flakes, if any, per this
  plan's design-decisions notes).

**Step 2:** `cd frontend && npx vitest run && npx tsc -b`
- PASS, no type errors.

**Step 3:** `docker compose up -d --build backend worker frontend`, then
`docker compose exec backend alembic upgrade head` (applies migration
0007).

**Step 4:** Live smoke test via a throwaway session (same idiom this
session used repeatedly - create a throwaway user via
`app.auth.service.create_user`, log in, exercise the flow, clean up
after): send a chat message expected to trigger rule 4's "not in the
documentation" answer (e.g. ask about something with zero ready
documents, or a document that clearly doesn't cover the topic), confirm
it shows up in Improvements' No Answer list with the right question
text and no visible marker; dislike a reply, confirm it shows up in the
Dislikes list; remove both, confirm they disappear from their lists but
the messages themselves still show in ordinary Chat history. Clean up
the throwaway user/session and any seeded chat rows afterward, same as
every other live check this session.

**Step 5: Commit** (only if Steps 1-2 required fixes)

```bash
git add -A
git commit -m "test: fix regressions found during Improvements-page smoke testing"
```
