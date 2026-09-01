---
sidebar_position: 5
title: Python and Django
description: What Asterweave applies automatically for Python and Django repositories.
---

# Python and Django

The repository's Python version, environment/package manager, formatter/linter/type checker, framework version, and architecture are always authoritative.

## Python

Preserves typing and async/sync boundaries; avoids mutable defaults and broad exception handling; validates untrusted data; uses parameterized database access, safe subprocess argument arrays, and safe paths/serialization; keeps resources in context managers. Never adds dependencies or regenerates lockfiles without approval.

## Django

Follows existing apps/services/selectors/forms/serializers/views/tasks patterns; enforces authentication and object-level authorization server-side; uses ORM projections/`select_related`/`prefetch_related` deliberately to avoid N+1 and unbounded querysets; uses transactions and locking where invariants require them; reviews migrations for locks, backfill, reversibility, and deployment order; protects CSRF, sessions/cookies, file uploads, and redirects.

## Testing and gates

Follows pytest/unittest and existing fixtures/factories — unit-testing rules, integration-testing the ORM, migrations, views/APIs, auth, and tasks — using isolated test databases and deterministic clocks/data, never production or shared environments. Candidate commands come from `pyproject`/tox/nox/CI: locked environment sync, formatter check, Ruff/Flake8, mypy/pyright, and pytest or `manage.py test`.
