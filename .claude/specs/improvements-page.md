# Improvements Page

## Goal
Give an operator a dedicated place to see where the chat assistant is
failing users - messages that got a thumbs-down, and messages where the
assistant said the answer wasn't in the documentation - so they know what
to fix, without having to scroll the full chat history looking for them.

## Requirements

- A new sidebar entry, "Improvements", alongside the existing Upload /
  Chat / Relevance Preview / Logs & Stats entries.
- The page has two sub-tabs, switched the same way Logs & Stats' own
  Stats/Logs toggle works.
- **Sub-tab 1** shows two separately-styled lists, matching this app's
  existing visual language (not a generic unstyled table):
  - Every message currently marked disliked.
  - Every message where the assistant told the user the answer wasn't
    available in the uploaded documentation.
- Each list is independently filterable by a time range: last 1 day,
  last 7 days, last 30 days, or all time.
- Each list entry can be removed individually:
  - Removing a disliked entry un-dislikes that message (same effect as
    clicking the dislike button again in Chat) - the message itself stays
    in ordinary chat history.
  - Removing a "no answer" entry clears that message's flag - the
    message itself stays in ordinary chat history, just no longer listed
    here.
- Detecting "the assistant said the answer wasn't in the documentation"
  must not depend on matching specific wording in the reply text - the
  assistant replies in whatever language the user asked in, so a fixed
  phrase match would miss most non-English cases. This requires a
  reliable, language-independent signal from the assistant's own
  generation step, recorded as a durable flag per message (see Open
  Questions for what's already settled about this and what isn't).
- No per-user filtering on either list (explicitly out of scope for this
  pass - see Non-Goals). Time-range filtering only.
- **Sub-tab 2** is a placeholder for a future feature: a page shell
  (matching this page's visual style) containing one button, "Analyze
  with AI" (or equivalent), that does not perform any action yet.
- This is a schema-affecting change: it requires persisting the "no
  answer" flag per message, and a timestamp for when a message was
  disliked (distinct from when it was originally sent) so the dislikes
  list's time filter reflects when the dislike happened, not when the
  underlying question was asked.

## Acceptance Criteria
- [ ] "Improvements" appears in the sidebar and navigates to the new page.
- [ ] The page shows a Stats/Logs-style two-way sub-tab toggle.
- [ ] Sub-tab 1 shows a Dislikes list and a separate "No Answer" list,
      each styled consistently with the rest of the app.
- [ ] Disliking a message in Chat makes it appear in the Dislikes list;
      un-disliking it (from Chat or from the list's own remove action)
      removes it from the list without deleting the message.
- [ ] A message where the assistant indicates the answer isn't in the
      documentation appears in the "No Answer" list, regardless of what
      language the conversation was in; removing it from the list clears
      the flag without deleting the message.
- [ ] Each list's time-range filter (1 day / 7 days / 30 days / all time)
      actually changes which entries are shown, using the relevant
      timestamp for that list (dislike time for the Dislikes list,
      message time for the "No Answer" list).
- [ ] Sub-tab 2 renders with the "Analyze with AI" button present and
      inert (no request fires, no crash) when clicked.

## Non-Goals
- Per-user filtering on either list (there is currently no concept of
  "which admin sent this chat message" - out of scope for this pass,
  can be added later independently of this feature).
- The actual AI-driven documentation-gap analysis behind sub-tab 2's
  button - only the placeholder shell + inert button are in scope here.
- Any change to the chat system prompt's user-facing wording for how the
  assistant tells a user it doesn't know an answer - only how that
  moment gets flagged internally.
- Bulk actions (e.g. "clear all dislikes at once") - removal is
  per-entry only.

## Open Questions
- None blocking - the detection mechanism (a stripped marker token from
  the assistant's own reply, recorded as a `no_answer_found` flag) and
  the removal semantics (clear the flag / un-dislike, never delete the
  underlying message) were already settled in discussion before this
  spec was written.
