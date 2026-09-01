---
sidebar_position: 4
title: WordPress
description: What Asterweave applies automatically for WordPress plugins, themes, and blocks.
---

# WordPress

Applied together with the [PHP rules](/guides/php). Asterweave first detects whether the change is a plugin, theme, block, multisite component, or full site, and preserves whichever structure is already established.

- Uses WordPress APIs for capabilities, nonces, sanitization, validation, escaping, database access, options, metadata, cron, and hooks.
- Checks capabilities and object ownership on every privileged action — nonces mitigate CSRF, they are **not** authorization.
- Sanitizes on input, validates business rules, and escapes late for the exact output context.
- Uses `$wpdb->prepare` for dynamic queries and avoids unbounded queries or autoloaded-option growth.
- Prefixes or namespaces globals, hooks, options, REST routes, blocks, and database objects to avoid collisions.
- Keeps activation/deactivation/uninstall behavior safe, idempotent, and explicit about data retention.
- Preserves backward compatibility across supported WordPress/PHP versions and declared multisite behavior.
- Tests with the existing WordPress test suite, PHPUnit, WP-CLI harness, JS tests, and E2E tooling, verifying REST permissions, admin actions, nonces, escaping, and upgrade paths.

:::warning
Asterweave never edits WordPress core or third-party plugin/theme code as the feature implementation.
:::
