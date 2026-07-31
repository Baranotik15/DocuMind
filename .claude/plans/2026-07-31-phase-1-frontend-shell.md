# Phase 1: Frontend Shell (Mocked Backend) — Implementation Plan

> **For Claude:** This project does not use `superpowers:executing-plans`.
> Execute via `/work`, one task at a time, on branch
> `feature/phase-1-frontend-shell`. Per standing project convention:
> implement exactly one task, commit it, report, and **stop** — wait for
> explicit user go-ahead before starting the next task. This is
> frontend/UI-domain work, so per `CLAUDE.md`'s Agent Routing table, run
> each task's implementation through the `web-frontend` agent (not a
> generic subagent), referencing `.claude/skills/ui-design/STYLE_GUIDE.md`
> for component conventions. Push after each task so it's reviewable; per
> default project convention this phase gets a PR reviewed and merged
> per task (unless told otherwise, as was done for Phase 0's backend
> track).

**Goal:** Build a navigable Upload/Chunks/Chat/Dashboard shell on the
Phase 0 React+Mantine frontend, with every page's data sourced from one
swappable mock-data seam instead of the real backend.

**Architecture:** `react-router-dom` drives navigation inside a Mantine
`AppShell` layout (nav + content area). Every page depends only on an
`ApiClient` interface (`frontend/src/api/client.ts`); the concrete
implementation bound to it for this phase is a mock (`mockClient.ts`) —
a later phase swaps in a real HTTP-backed implementation without touching
any page component.

**Tech Stack:** React, Mantine (`@mantine/core`), `react-router-dom`,
Vitest + Testing Library (already set up in Phase 0).

---

## Task 1: Routing + AppShell layout + test utilities

**Files:**
- Create: `frontend/src/layout/AppLayout.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Create: `frontend/src/test-utils.tsx`
- Modify: `frontend/package.json` (add `react-router-dom`)
- Reference: `frontend/src/App.tsx` (current Phase 0 version — single
  `MantineProvider` + `Title`, replace with the routed layout below)

**Contracts:**

```tsx
// frontend/src/layout/AppLayout.tsx
export function AppLayout(props: { children: React.ReactNode }): JSX.Element
// Renders a Mantine AppShell: header with "DocuMind" brand text, nav
// with links to /upload, /chunks, /chat, /dashboard (React Router
// <NavLink>), and props.children in the main content area.
```

```tsx
// frontend/src/App.tsx
export function App(): JSX.Element
// Wraps <MantineProvider><BrowserRouter><AppLayout><Routes>...</Routes>
// </AppLayout></BrowserRouter></MantineProvider>. Routes: "/" redirects
// to "/upload"; "/upload", "/chunks", "/chat", "/dashboard" each render
// their page component (placeholder divs until Tasks 3-6 land).
```

```tsx
// frontend/src/test-utils.tsx
export function renderWithProviders(
  ui: React.ReactElement,
  options?: { route?: string },
): ReturnType<typeof render>
// Wraps ui in <MantineProvider><MemoryRouter initialEntries={[route ?? '/']}>
// so page tests don't repeat this boilerplate. Re-exports testing-library's
// render/screen for convenience (see how other test files in this repo
// import from '@testing-library/react' directly - keep the same
// screen/fireEvent exports available from here too).
```

**Integration:**
- `frontend/src/main.tsx` is unchanged - it still renders `<App />`.
- Existing `frontend/src/App.test.tsx` currently asserts
  `screen.getByText('DocuMind')` - update it to use `renderWithProviders`
  and assert the brand text plus that nav links to all four pages exist
  (`screen.getByRole('link', { name: /upload/i })` etc.).

**Step 1: Write the failing test**

Update `App.test.tsx`: render `<App />` via `renderWithProviders`, assert
"DocuMind" brand text is present and there are nav links named
Upload/Chunks/Chat/Dashboard.

Run: `npm test`
Expected: FAIL (`AppLayout` and routes don't exist yet)

**Step 2: Implement**

Add `react-router-dom` to `package.json`. Implement `AppLayout.tsx`,
`test-utils.tsx`, and update `App.tsx` per the contracts above. Use
placeholder `<div>Upload page</div>`-style components inline for the four
routes for now - Tasks 3-6 replace them with real page components.

**Step 3: Verify**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/src/layout frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/test-utils.tsx frontend/package.json frontend/package-lock.json
git commit -m "feat: add routing and AppShell layout for the four pages"
```

---

## Task 2: Mock API client (the swappable seam)

**Files:**
- Create: `frontend/src/api/types.ts`
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/api/mockClient.ts`
- Test: `frontend/src/api/mockClient.test.ts`

**Contracts:**

```typescript
// frontend/src/api/types.ts
export interface DocumentSummary {
  id: string
  filename: string
  status: 'uploaded' | 'chunking' | 'ready'
  uploadedAt: string
}

export interface Chunk {
  id: string
  documentId: string
  originalContent: string
  editedContent: string
  isDirty: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  disliked: boolean
}

export interface DashboardEvent {
  id: string
  type: string
  timestamp: string
  detail: string
}
```

```typescript
// frontend/src/api/client.ts
export interface ApiClient {
  listDocuments(): Promise<DocumentSummary[]>
  uploadDocument(file: File): Promise<DocumentSummary>
  getChunks(documentId: string): Promise<Chunk[]>
  saveChunks(documentId: string, chunks: Chunk[]): Promise<void>
  listChatMessages(): Promise<ChatMessage[]>
  sendChatMessage(content: string): Promise<ChatMessage>
  dislikeMessage(messageId: string): Promise<void>
  getDashboardEvents(): Promise<DashboardEvent[]>
}
```

```typescript
// frontend/src/api/mockClient.ts
export const mockApiClient: ApiClient = { /* ... */ }

// frontend/src/api/index.ts (or export from client.ts)
export const apiClient: ApiClient = mockApiClient
// A later phase changes only this binding to a real HTTP-backed
// implementation - no page component import changes.
```

**Integration:**
- No page imports this yet (Tasks 3-6 will `import { apiClient } from
  'app/api/client'` — wire up the actual re-export location as you build
  it, keep it consistent).

**Step 1: Write the failing test**

`mockClient.test.ts`: assert `mockApiClient.listDocuments()` resolves to a
non-empty array of `DocumentSummary`; assert `getChunks(id)` returns
chunks whose `documentId` matches; assert `saveChunks` updates
`isDirty`/`editedContent` for subsequent `getChunks` calls on the same
mock store; assert `dislikeMessage` flips `disliked` to `true` for that
message on subsequent `listChatMessages` calls.

Run: `npm test`
Expected: FAIL (module doesn't exist)

**Step 2: Implement**

Implement an in-memory mock store (module-level array/object) backing
`mockApiClient`, matching `ApiClient` exactly.

**Step 3: Verify**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/src/api
git commit -m "feat: add ApiClient interface and mock implementation"
```

---

## Task 3: Upload page

**Files:**
- Create: `frontend/src/pages/UploadPage.tsx`
- Test: `frontend/src/pages/UploadPage.test.tsx`
- Modify: `frontend/src/App.tsx` (wire real `<UploadPage />` into `/upload`)
- Reference: `frontend/src/test-utils.tsx` (use `renderWithProviders`)

**Contracts:**

```tsx
// frontend/src/pages/UploadPage.tsx
export function UploadPage(): JSX.Element
// On mount, calls apiClient.listDocuments() and renders each as a row
// (filename + status) in a Mantine Table. Renders a Mantine FileInput;
// selecting a file calls apiClient.uploadDocument(file) and appends the
// returned DocumentSummary to the rendered list.
```

**Step 1: Write the failing test**

Test that the mocked documents' filenames appear after render (async -
use `findByText`). Test that selecting a file via the `FileInput` results
in a new row appearing whose filename matches the uploaded file's name.

Run: `npm test`
Expected: FAIL (`UploadPage` doesn't exist)

**Step 2: Implement**

Implement `UploadPage.tsx` per contract; wire it into the `/upload` route
in `App.tsx`, replacing the Task 1 placeholder.

**Step 3: Verify**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/src/pages/UploadPage.tsx frontend/src/pages/UploadPage.test.tsx frontend/src/App.tsx
git commit -m "feat: add Upload page backed by the mock api client"
```

---

## Task 4: Chunks page

**Files:**
- Create: `frontend/src/pages/ChunksPage.tsx`
- Test: `frontend/src/pages/ChunksPage.test.tsx`
- Modify: `frontend/src/App.tsx` (wire `<ChunksPage />` into `/chunks`)

**Contracts:**

```tsx
// frontend/src/pages/ChunksPage.tsx
export function ChunksPage(): JSX.Element
// On mount, calls apiClient.listDocuments() to populate a Mantine Select
// for choosing the active document (default: first document). On
// selection change, calls apiClient.getChunks(documentId) and renders
// each chunk's editedContent in a Mantine Textarea. Edits update local
// component state (not persisted until Save). A Save button calls
// apiClient.saveChunks(documentId, chunks) with the current local state.
```

**Step 1: Write the failing test**

Test that mocked chunk content renders in textareas. Test that editing a
textarea's value is reflected in that textarea (controlled input). Test
that clicking Save calls `apiClient.saveChunks` with the edited content
(spy/mock the api client module for this assertion, per
`.claude/docs/testing.md` - mock only the external boundary, not the
component's own logic).

Run: `npm test`
Expected: FAIL (`ChunksPage` doesn't exist)

**Step 2: Implement**

Implement `ChunksPage.tsx` per contract; wire into `/chunks` route.

**Step 3: Verify**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/src/pages/ChunksPage.tsx frontend/src/pages/ChunksPage.test.tsx frontend/src/App.tsx
git commit -m "feat: add Chunks page with in-place editing backed by the mock api client"
```

---

## Task 5: Chat page

**Files:**
- Create: `frontend/src/pages/ChatPage.tsx`
- Test: `frontend/src/pages/ChatPage.test.tsx`
- Modify: `frontend/src/App.tsx` (wire `<ChatPage />` into `/chat`)

**Contracts:**

```tsx
// frontend/src/pages/ChatPage.tsx
export function ChatPage(): JSX.Element
// On mount, calls apiClient.listChatMessages() and renders each message
// (role-based alignment/styling). Each assistant message has a dislike
// icon button calling apiClient.dislikeMessage(id) and reflecting the
// disliked state visually. A text input + send button calls
// apiClient.sendChatMessage(content) and appends the result. Renders a
// labeled placeholder element (e.g. a Mantine Badge with
// data-testid="context-indicator") for the future context-switch
// indicator - no behavior required yet, per
// .claude/specs/phase-1-frontend-shell.md's Non-Goals.
```

**Step 1: Write the failing test**

Test that mocked messages render. Test that clicking dislike on an
assistant message calls `apiClient.dislikeMessage` with that message's id
and the button reflects a disliked state afterward. Test that sending a
message appends a new message to the rendered list. Test that the
`context-indicator` placeholder element is present.

Run: `npm test`
Expected: FAIL (`ChatPage` doesn't exist)

**Step 2: Implement**

Implement `ChatPage.tsx` per contract; wire into `/chat` route.

**Step 3: Verify**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/src/pages/ChatPage.tsx frontend/src/pages/ChatPage.test.tsx frontend/src/App.tsx
git commit -m "feat: add Chat page with dislike control backed by the mock api client"
```

---

## Task 6: Dashboard page

**Files:**
- Create: `frontend/src/pages/DashboardPage.tsx`
- Test: `frontend/src/pages/DashboardPage.test.tsx`
- Modify: `frontend/src/App.tsx` (wire `<DashboardPage />` into `/dashboard`)

**Contracts:**

```tsx
// frontend/src/pages/DashboardPage.tsx
export function DashboardPage(): JSX.Element
// On mount, calls apiClient.getDashboardEvents() and renders each event
// (timestamp, type, detail) as a row in a Mantine Table. No charting
// library is introduced in this task - a table satisfies the "logs/data
// tables" requirement from the original spec; charts are a later,
// YAGNI-deferred addition once there's real metric data driving them.
```

**Step 1: Write the failing test**

Test that mocked event rows (matching on `type`/`detail` text) render in
the table.

Run: `npm test`
Expected: FAIL (`DashboardPage` doesn't exist)

**Step 2: Implement**

Implement `DashboardPage.tsx` per contract; wire into `/dashboard` route.

**Step 3: Verify**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/src/pages/DashboardPage.tsx frontend/src/pages/DashboardPage.test.tsx frontend/src/App.tsx
git commit -m "feat: add Dashboard page backed by the mock api client"
```

---

## Task 7: Full acceptance check

*(Verification task against `.claude/specs/phase-1-frontend-shell.md`'s
Acceptance Criteria - no new code expected unless a check fails.)*

**Step 1**

Run: `npm run build && npm test` (all pages, full suite)
Expected: build succeeds, all tests pass

**Step 2**

Run: `docker compose build frontend && docker compose up -d`
Expected: `frontend` container running, reachable at
http://localhost:5173

**Step 3**

Manually navigate `/upload`, `/chunks`, `/chat`, `/dashboard` (or verify
via the route-level tests from Tasks 3-6) - confirm each page's distinct
content renders.

**Step 4**

Run: `grep -rn "fetch(\|axios" frontend/src --include=*.tsx --include=*.ts | grep -v mockClient`
Expected: no matches outside the mock client - confirms no page reaches
the real backend yet, per the spec's Non-Goals.

**Step 5: Commit**

Only if Steps 1-4 required fixes; otherwise this task is verification-only.
