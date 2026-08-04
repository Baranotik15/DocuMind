# Testing Guidelines

**Principle: Test behavior, not implementation. Mocks should replace boundaries, not logic.**

## Testing Approach

- Pick a test framework appropriate to each language/runtime in the project.
- Keep unit tests fast and deterministic; reserve slower, environment-dependent
  tests for the integration suite.
- Where the project uses code generation for API/client contracts, rely on the
  generated types for cross-boundary type safety instead of hand-written mocks.

## Mock at the Right Level

Don't mock the runtime primitives you're trying to exercise. Test the real code
path and only substitute the external boundary.

```text
# BAD: mocking the async runtime bypasses all async behavior
mock(runtime.run) -> returns fake_result
result = run_task()

# GOOD: actually execute the async code path
result = await service.sync_client_data(client_id=1, client_name="test")
```

### Assert on the Real Effect

When your test double stands in for an asynchronous dependency, assert that it
was actually awaited/invoked with the expected arguments — not merely that it
was referenced. Many mocking libraries distinguish "was called" from "was
awaited"; use the await-aware assertion so async regressions can't hide.

## What to Mock vs. What to Test Real

| Mock These (External Boundaries) | Test These Real (Internal Logic) |
|----------------------------------|----------------------------------|
| HTTP clients / API calls | Data transformation / mapping |
| External service SDKs | Business logic / validation |
| Third-party credentials | Async execution flow |

## Database Testing: Unit vs Integration

**Unit tests** that exercise branching logic *around* DB calls (e.g., "if flag
not found -> return False", "if the DB raises -> fail closed") should mock the DB
call. The DB session is a boundary in these tests — the goal is to verify how
the function responds to different query results, not whether the query itself is
correct.

```text
# GOOD: unit test mocking the DB call to test branching logic
mock_db.execute -> returns "not found"
result = check_feature_flag(db=mock_db, flag_key="power_dialer", client_id=1)
assert result is False   # verifies the "not found" branch
```

**Integration tests** that verify query correctness, ORM mappings, or
multi-table joins should run against a real test database:

```text
# GOOD: integration test with a real DB fixture for query correctness
result = run_query(test_db)
assert result == expected
```

**Rule of thumb:** If the test is about *what the function does with the query
result*, mock the DB. If the test is about *whether the query returns the right
data*, use a real test DB.

## Background Job / Task Testing

Prefer executing tasks in a synchronous/eager mode so the real task body runs,
rather than asserting that a scheduling primitive was invoked. Asserting on the
scheduler proves the job was enqueued, not that it does the right thing.

## Test Structure Checklist

Before submitting test code, verify:
- [ ] Tests verify **behavior**, not that mocks were called
- [ ] Async code is actually awaited/executed, not mocked away at the runtime level
- [ ] Data transformations have explicit unit tests
- [ ] DB query correctness tested with a real test DB; branching logic around DB calls can use a mocked DB call
- [ ] Integration tests can run in CI (use HTTP mocks, not skip decorators)
