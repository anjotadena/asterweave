---
name: test
description: Design, add, and run risk-based unit, integration, contract, and regression tests using repository-native tooling, while refusing test weakening and recording reproducible evidence.
argument-hint: "[scope|changed-files]"
model: sonnet
effort: high
---

# Test the change

Test `$ARGUMENTS` under [testing policy](../../references/testing.md), [repository adapter](../../references/repository-adapter.md), and the detected stack rule pack. Resolve the `test` route, invoke configured project skills, and delegate to its project agent or `asterweave:test-engineer` when no route exists.

1. Map changed behavior and acceptance criteria to tests before writing more tests.
2. Inspect existing test organization, fixtures, builders, mocks, naming, and CI commands.
3. Add focused tests for success, boundary, negative, failure, authorization, concurrency/idempotency, compatibility, and regression paths as applicable.
4. Use integration/contract tests at database, network, message, filesystem, plugin, and process boundaries. Do not mock the behavior being validated.
5. Run targeted tests first, then configured quality gates and required broader suites, build, lint/static analysis, and coverage commands already defined by the repository.
6. Investigate failures. Do not delete, skip, relax, over-mock, snapshot-bless, or lower coverage merely to pass.
7. Validate delegated claims from command output and return exact commands, exit status, test counts, coverage delta when available, skipped checks with justification, failure signature, and `unit-test` plus `integration-test` evidence summaries.
