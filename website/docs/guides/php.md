---
sidebar_position: 3
title: PHP and Laravel
description: What Asterweave applies automatically for PHP and Laravel repositories.
---

# PHP and Laravel

The repository's PHP version, Composer lock, framework version, static-analysis config, coding standard, and architecture are always authoritative.

## PHP

Preserves strict types and existing namespace/autoload conventions; validates input and encodes output for the target context; uses parameterized queries/ORM bindings; avoids dynamic code execution, unsafe deserialization, and user-controlled paths/includes; handles money with appropriate decimal/value objects and time zones explicitly.

## Laravel

Follows existing controllers/actions/services/jobs/events/policies/form-request patterns rather than inventing a new layer; enforces authorization with policies/gates at the resource boundary, not only UI visibility; prevents mass-assignment, N+1 queries, and unsafe raw SQL; makes queued jobs idempotent and retry-safe; reviews migrations for locking, defaults, backfill, rollback, and zero-downtime compatibility.

## Testing and gates

Follows whichever of PHPUnit/Pest the repository already uses — unit-testing rules/value objects, feature/integration-testing HTTP, policy/auth, database, and queue/event behavior — using factories/fixtures and configured database isolation, never a shared or production database. Candidate commands come from Composer scripts/CI: install, formatter check, PHPStan/Psalm, and PHPUnit/Pest. Migrations and seed/reset commands are never run without explicit approval and an isolated environment.
