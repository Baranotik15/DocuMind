# /regression-test - Regression Test Plan Generator

Generate a risk-ranked regression test plan from recent commits. Use before production deployments or to audit changes over a time period.

## Usage

```text
/regression-test                          # Last 24 hours (default for deploys)
/regression-test 7 days                   # Last 7 days
/regression-test 30 days --author=alice   # Last 30 days, specific author
/regression-test 2 hours                  # Last 2 hours (hot deploy)
```

## Arguments

Parse the user's input for:
- **Time window**: Number + unit (hours, days, weeks). Default: `24 hours`
- **Author filter**: `--author=<name>` to scope to one person's commits
- **Environment context**: If user mentions "prod deploy" or "staging", note it in the report header

## Step 1: Gather Commits

```bash
# Parse time window into git --since format
# Examples: "24 hours" -> "--since='24 hours ago'", "7 days" -> "--since='7 days ago'"

# All commits in window
git log --since='<TIME> ago' --oneline --no-merges

# If --author specified
git log --since='<TIME> ago' --author='<NAME>' --oneline --no-merges

# Get commit count for sanity check (include --author if specified)
git log --since='<TIME> ago' --oneline --no-merges | wc -l
```

If there are **zero commits**, report that and exit.
If there are **more than 100 commits**, warn the user and suggest narrowing the window.

## Step 2: Analyze Changes

For each commit (or batch if many), gather the diff:

```bash
# Files changed per commit (include --author='<NAME>' if specified)
git log --since='<TIME> ago' --no-merges --name-only --pretty=format:"--- %h %s"

# Full diff for the window (for deep analysis)
# When --author is specified, scope the commit range to only that author's commits
OLDEST=$(git log --since='<TIME> ago' --no-merges --format=%H | tail -1)
git diff $OLDEST^..HEAD --stat
git diff $OLDEST^..HEAD

# If --author specified, use only that author's commits for the diff range
OLDEST=$(git log --since='<TIME> ago' --author='<NAME>' --no-merges --format=%H | tail -1)
NEWEST=$(git log --since='<TIME> ago' --author='<NAME>' --no-merges --format=%H | head -1)
# Diff individual author commits rather than a range (avoids including others' changes)
git log --since='<TIME> ago' --author='<NAME>' --no-merges -p --stat
```

For large diffs (>50 files), analyze in batches by reading individual commit diffs.

## Step 3: Classify by Risk Domain

Categorize every changed file/function into a risk domain. Use file paths and content analysis:

### CRITICAL PATH (P0) - Must Test Before Deploy

These are revenue-impacting, core-flow-affecting, or data-integrity changes. Adapt the patterns below to your project's structure:

| Domain | File Patterns | Why Critical |
|--------|--------------|--------------|
| **Core Business Flow** | Primary user-facing transaction / workflow paths | Broken flows = immediate customer impact, lost revenue |
| **Payments / Billing** | `billing`, `pricing`, payment provider integrations | Failed payments = direct revenue loss |
| **Authentication** | `auth/`, `jwt`, `permissions`, `middleware/auth`, `login`, `token` | Auth failures = total platform lockout |
| **Multi-Tenancy** | Tenant-scoping filters, access-control checks, tenant-scoped base models | Tenant leak = security incident |
| **Database Migrations** | Migration files, `*.sql` | Schema changes can block deploys or break the runtime |
| **Data Integrity** | Records that back core transactions (orders, bookings, reservations) | Corrupted data = lost business |

### HIGH RISK (P1) - Test Before Deploy

| Domain | File Patterns | Why High Risk |
|--------|--------------|---------------|
| **External Integrations / Sync** | Third-party sync services, external API clients | Sync failures = stale or inconsistent data |
| **Background Jobs** | Task queues, workers, scheduled jobs | Silent failures, data processing delays |
| **API Schema** | API/GraphQL schema definitions | Breaking API changes for clients |
| **Notifications** | Email, SMS, chat, push notification code | Failed notifications = missed alerts |
| **Feature Flags** | `feature_flag`, `flags` | Wrong flag state = broken rollout |
| **Real-time / Streaming** | WebSocket, SSE, streaming endpoints | Broken live updates in UI |

### MEDIUM RISK (P2) - Verify After Deploy

| Domain | File Patterns | Why Medium Risk |
|--------|--------------|----------------|
| **Frontend Components** | UI component and page directories | Visual regressions, UX issues |
| **API Endpoints** | Non-auth, non-payment endpoints | Endpoint behavior changes |
| **Services** | Non-critical business-logic services | Business logic changes |
| **Config** | Config / settings / env handling | Environment-dependent behavior |
| **Onboarding** | `onboarding/`, `signup`, `registration` | New customer flow broken |

### LOW RISK (P3) - Spot Check

| Domain | File Patterns | Why Low Risk |
|--------|--------------|--------------|
| **Tests** | Test files and directories | Test-only changes don't affect production |
| **Docs** | `*.md`, `docs/` | No runtime impact |
| **Styling** | Stylesheets, theme files | Visual only |
| **Tooling** | `.claude/`, `scripts/`, build/dev tooling | Dev tooling only |
| **Type Stubs / Annotations** | Type-only changes | No runtime impact |

## Step 4: Generate the Report

Output the following report structure. **Be specific** - reference actual commit hashes, file names, and function names from the analysis.

---

```markdown
# Regression Test Report

**Window:** <start> to <end> (<N> commits)
**Authors:** <list of contributors>
**Context:** <pre-deploy / audit / user-specified>
**Generated:** <timestamp>

---

## Executive Summary

<2-3 sentences: what changed, overall risk level, key areas to watch>

---

## P0 - CRITICAL PATH (Must Test Before Deploy)

### <Domain Name>
**Commits:** <hash> <message>, ...
**Files:** <list>
**What Changed:** <specific description of the change>
**Risk:** <what could break>
**Test Plan:**
- [ ] <Specific test action with expected result>
- [ ] <Specific test action with expected result>
- [ ] <Specific test action with expected result>
**Verification Command (if applicable):**
\`\`\`bash
<command to verify, e.g., curl endpoint, check logs, run specific test>
\`\`\`

(Repeat for each P0 domain affected)

---

## P1 - HIGH RISK (Test Before Deploy)

### <Domain Name>
**Commits:** ...
**What Changed:** ...
**Test Plan:**
- [ ] ...

(Repeat for each P1 domain affected)

---

## P2 - MEDIUM RISK (Verify After Deploy)

### <Domain Name>
**Commits:** ...
**What Changed:** ...
**Quick Check:**
- [ ] ...

---

## P3 - LOW RISK (Spot Check)

<Brief list of low-risk changes, no detailed test plan needed>

---

## Cross-Cutting Concerns

<Flag anything that spans multiple domains or has unexpected interaction potential>

- **Database migration + app code**: If both changed, verify migration runs before new code deploys
- **Schema compatibility**: If data models and migrations both changed, verify the rollout order and that the runtime matches the migrated schema
- **Environment variables**: If new env vars added, verify they're wired into the deployment/infra config
- **Multi-tenancy**: If access control changed, verify tenant isolation

---

## Automated Test Coverage

**Existing test coverage for changed code:**
- <List any tests that directly cover the changed code>
- <Flag gaps where critical changes lack test coverage>

**Suggested test commands:**
\`\`\`bash
# Run the test suite for affected areas (adapt to your stack)
<test-runner> <specific test paths>

# Run the full suite if migration or model changes
<test-runner>
\`\`\`

---

## Deployment Checklist

- [ ] All P0 items tested and verified
- [ ] All P1 items tested
- [ ] Database migrations reviewed (if any)
- [ ] Environment variables configured (if any new ones)
- [ ] Feature flags set correctly (if any)
- [ ] Rollback plan identified
- [ ] Monitoring dashboards open during deploy

---

## Risk Score: <LOW | MEDIUM | HIGH | CRITICAL>

<One sentence justification based on P0/P1 findings>
```

---

## Implementation Notes

### Analyzing Commits Efficiently

- For **< 20 commits**: Read the full diff of each commit for detailed analysis
- For **20-50 commits**: Use `--stat` first, then deep-dive on critical-path files only
- For **50+ commits**: Summarize by file path patterns first, then sample high-risk commits

### When Multiple Critical Path Areas Are Affected

If 3+ P0 domains are affected, escalate the overall risk score to CRITICAL regardless of individual change sizes. Small changes across many critical systems compound risk.

### Identifying Subtle Risks

Watch for these non-obvious regression sources:
- **Import/module load-order changes** in package initialization files
- **Default parameter changes** in widely-called functions
- **Background job / task signature changes** (breaks running workers until redeployed)
- **API field additions** (safe) vs **removals/renames** (breaking)
- **Database index changes** (can cause query plan shifts under load)
- **Environment variable renames** (breaks deploy if not coordinated)

### Using Your CLI / Ops Tooling for Verification

When generating test plans, include relevant operational commands for your environment (adapt to your stack):

```bash
# Check for errors after deploy (query logs)
<ops-cli> logs query <env>

# Verify health
<ops-cli> health check <env>

# Check metrics for performance regressions
<ops-cli> metrics endpoints <env>

# Trace a specific request/transaction end to end
<ops-cli> logs trace <env> <request_id>
```

## Examples

### Pre-Deploy (Default)
```text
/regression-test
```
Generates a test plan for the last 24 hours, optimized for go/no-go deploy decision.

### Sprint Audit
```text
/regression-test 14 days --author=alice
```
Generates a comprehensive audit of one developer's changes over a sprint.

### Hot Deploy
```text
/regression-test 2 hours
```
Quick analysis for an urgent patch deployment.
