---
name: review-feedback
description: "Iterate on code review feedback from a pull request. Use when addressing reviewer comments, implementing requested changes, or responding to PR feedback."
argument-hint: "[pr-url-or-number]"
---

# Review Feedback Iteration

You are iterating on code review feedback. Your job is to systematically process each piece of feedback, understand it deeply, and either implement it or provide well-reasoned pushback.

## Gathering Context

**If a PR was provided as an argument:**
Use `$ARGUMENTS` as the PR reference (URL or number).

**If no argument was provided:**
Detect the current PR from the active branch using `gh pr view`.

Gather all review feedback:
```
gh pr view <pr> --json reviews,comments,number,url,title,body
gh api repos/{owner}/{repo}/pulls/<number>/comments
gh api repos/{owner}/{repo}/pulls/<number>/reviews
```

Read the PR diff to understand the full changeset:
```
gh pr diff <pr>
```

## Processing Protocol

Work through feedback **one item at a time**, in order. For each piece of feedback, follow ALL six steps before moving to the next:

### Step 1: Read
Read the complete feedback comment. Include the file, line, and full text. Quote the reviewer's words exactly.

### Step 2: Understand
Restate the feedback in your own words. What is the reviewer actually asking for? What is their underlying concern? If there are multiple interpretations, identify the most likely one.

### Step 3: Verify
Check the referenced code in the codebase. Read the file(s) mentioned. Confirm whether the reviewer's observation is factually accurate — they may be looking at stale code, a different branch, or misreading the diff.

### Step 4: Evaluate
Determine if this feedback applies in THIS codebase. Consider:
- Does the project already have an established pattern that differs from the suggestion?
- Would this change conflict with other parts of the system?
- Is the scope appropriate for this PR?
- Does the benefit justify the change?

### Step 5: Decide & Respond
Either **acknowledge** (you will implement it) or **push back** (with reasoning). Draft a reply comment. Do NOT post it yet — present it to the user for approval first.

### Step 6: Implement (if applicable)
If acknowledged, make the code change. Keep changes minimal and focused on exactly what was requested. After implementing, show the user what changed.

---

## When to Push Back

Push back is appropriate when any of the following are true:

1. **Contradicts established project patterns.** The suggestion conflicts with conventions used consistently throughout the codebase. Cite specific examples of the existing pattern.

2. **Adds complexity without clear benefit.** The change makes the code harder to read, maintain, or understand, and the benefit is marginal or hypothetical. Simpler is better unless there's a concrete reason.

3. **Out of scope for this PR.** The feedback is valid but addresses something unrelated to the PR's purpose. Acknowledge the point and suggest a follow-up issue or PR instead.

4. **Based on incorrect assumptions.** The reviewer may have missed context — a related file, a constraint, a prior discussion. Politely provide the missing context.

5. **Stylistic preference without project backing.** The suggestion is a matter of personal style (naming, formatting, code organization) not backed by the project's linter, style guide, or established conventions.

6. **Would break backwards compatibility or existing behavior.** The change would require cascading modifications or introduce regressions in areas outside the PR's scope.

7. **Already handled elsewhere.** The concern is addressed in another part of the code, a different PR, or a prior commit that the reviewer may not have seen.

When pushing back, always:
- Acknowledge the reviewer's point ("I see what you mean about X")
- Explain your reasoning concretely with references to code
- Offer an alternative if possible
- Keep the tone collaborative, not defensive

---

## Responding to GitHub Comments

### Replying in the correct thread

**For review comments (inline on code):**
```bash
# Reply to a specific review comment thread
gh api repos/{owner}/{repo}/pulls/<number>/comments/<comment_id>/replies \
  -f body="Your reply here"
```

**For top-level PR comments (conversation tab):**
```bash
# Reply to a top-level issue/PR comment
gh api repos/{owner}/{repo}/issues/<number>/comments \
  -f body="Your reply here"
```

**For review-level responses (replying to a full review):**
```bash
# Reply to a review comment thread using the pull request review comment ID
gh api repos/{owner}/{repo}/pulls/<number>/comments/<comment_id>/replies \
  -f body="Your reply here"
```

### Finding comment IDs

```bash
# List all review comments with their IDs
gh api repos/{owner}/{repo}/pulls/<number>/comments --jq '.[] | {id, path, body}'

# List top-level PR/issue comments
gh api repos/{owner}/{repo}/issues/<number>/comments --jq '.[] | {id, body}'
```

### Comment formatting guidelines

- **When you implemented the change:** Start with "Done" or "Fixed" followed by a brief note on what you did, especially if your implementation differs slightly from what was suggested.
- **When pushing back:** Lead with acknowledgment, then your reasoning. Keep it concise.
- **Reference commits:** If you made a commit addressing the feedback, mention it: "Addressed in abc1234."
- **Multi-part feedback:** If a single comment contains multiple points, address each one explicitly (use quoted replies or numbered responses).

### Important rules

- ALWAYS present draft replies to the user for approval before posting to GitHub.
- NEVER post replies automatically — the user must review and approve every response.
- After the user approves, post the reply and move to the next feedback item.
- If you made code changes, commit them before replying so you can reference the commit.

---

## Workflow Summary

1. Gather all feedback from the PR
2. List all feedback items as a numbered summary for the user
3. Process each item through the 6-step protocol
4. For each item: present your analysis and draft reply to the user
5. Wait for user approval before posting any reply
6. After all items are processed, summarize what was done

Present a clear status after each item:
- **Implemented**: description of change
- **Pushed back**: summary of reasoning
- **Deferred**: created follow-up issue/noted for future PR
