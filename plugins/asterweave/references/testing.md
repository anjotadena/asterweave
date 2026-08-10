# Risk-based testing policy

## Test selection

Use the testing pyramid appropriate to the repository, not fixed percentages:

- unit tests for business rules, branches, transformations, validation, and error mapping;
- integration/contract tests for database, HTTP, messaging, filesystem, external API, plugin, and process boundaries;
- E2E/runtime verification for critical user journeys and platform behavior;
- regression tests that fail before the fix and pass after it;
- security tests for authorization, tenant/object isolation, injection, unsafe input, and sensitive data handling;
- migration/compatibility tests when data or public contracts change.

## Quality rules

- Inspect existing framework, naming, fixtures, builders, test doubles, and CI configuration.
- Prefer deterministic clocks, IDs, ports, data, and cleanup.
- Keep tests independent and parallel-safe unless isolation is impossible and documented.
- Mock external dependencies, not the business behavior being validated.
- Assert observable behavior and contracts rather than private implementation detail.
- Do not delete, skip, relax, over-mock, snapshot-bless, add arbitrary waits, or lower coverage to hide a failure.
- Treat flaky tests as defects. Reproduce and classify them; do not retry indefinitely.
- Use coverage to find gaps, not as proof of correctness.

## Gate order

1. formatter and focused static feedback;
2. changed-area unit tests;
3. relevant integration/contract tests;
4. build/type analysis/lint;
5. broader regression suite proportional to risk;
6. runtime acceptance verification;
7. final combined run after merges or generated changes.

Record exact commands, exit status, counts, duration when useful, report paths, environment, and justified skipped categories.
