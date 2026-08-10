# Python and Django

Repository Python version, environment/package manager, formatter/linter/type checker, framework version, and architecture are authoritative.

## Python

- Preserve typing and async/sync boundaries. Avoid mutable defaults and broad exception handling.
- Validate untrusted data, use parameterized database access, safe subprocess argument arrays, safe paths, and safe serialization.
- Keep resources in context managers and make time zones/encoding explicit.
- Do not add dependencies or regenerate lockfiles without approval.

## Django

- Follow existing apps/services/selectors/forms/serializers/views/tasks patterns.
- Enforce authentication and object-level authorization server-side.
- Use ORM projections/select/prefetch deliberately; avoid N+1 and unbounded querysets.
- Use transactions and locking where invariants require them; keep external side effects ordered safely around commits.
- Review migrations for locks, backfill, reversibility, deployment order, defaults, indexes, and mixed-version compatibility.
- Protect CSRF, sessions/cookies, file uploads, templates, redirects, and admin actions.

## Testing and gates

- Follow pytest/unittest and existing fixtures/factories. Unit-test rules; integration-test ORM, migrations, views/APIs, auth, tasks, and external contracts.
- Use isolated test databases and deterministic clocks/data. Do not point tests at production or shared environments.
- Candidate commands come from pyproject/tox/nox/CI: locked environment sync, formatter check, Ruff/Flake8, mypy/pyright, pytest or `manage.py test`, migration consistency, and runtime verification.
