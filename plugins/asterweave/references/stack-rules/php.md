# PHP and Laravel

Repository PHP version, Composer lock, framework version, static-analysis config, coding standard, and architecture are authoritative.

## PHP

- Preserve strict types and existing namespace/autoload conventions.
- Validate input and encode output for the target context. Use parameterized queries/ORM bindings.
- Avoid dynamic code execution, unsafe deserialization, user-controlled paths/includes, and suppressed errors.
- Handle money with appropriate decimal/value objects, time zones explicitly, and transactions for multi-write invariants.
- Keep secrets in environment/config providers and logs free of sensitive data.

## Laravel

- Follow existing controllers/actions/services/jobs/events/policies/form requests/resources patterns; do not invent a new layer.
- Enforce authorization with policies/gates at the resource boundary, not only UI visibility.
- Prevent mass-assignment, N+1 queries, unbounded collections, unsafe raw SQL, and duplicate jobs/events.
- Make queued jobs idempotent and retry-safe; define transaction/event ordering intentionally.
- Review migrations for locking, defaults, backfill, rollback, indexes, and zero-downtime compatibility.
- Use API resources and established exception/error response conventions.

## Testing and gates

- Follow PHPUnit/Pest already used. Unit-test rules/value objects; feature/integration-test HTTP, policy/auth, database, queue/event, validation, serialization, and failure behavior.
- Use factories/fixtures and database isolation already configured. Do not target shared or production databases.
- Candidate commands come from Composer scripts/CI: `composer install`, formatter check, PHPStan/Psalm, PHPUnit/Pest, and framework-specific checks. Never run migrations or seed/reset commands without explicit approval and an isolated environment.
