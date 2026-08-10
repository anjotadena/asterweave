# WordPress

Apply with the PHP rules. Detect whether this is a plugin, theme, block, multisite component, or full site and preserve its established structure.

- Use WordPress APIs for capabilities, nonces, sanitization, validation, escaping, database access, URLs, HTTP, filesystem, options, metadata, cron, and hooks.
- Check capabilities and object ownership in every privileged action. Nonces mitigate CSRF; they are not authorization.
- Sanitize on input, validate business rules, and escape late for the exact output context.
- Use `$wpdb->prepare` for dynamic queries and avoid unbounded queries/autoloaded option growth.
- Prefix or namespace globals, hooks, options, REST routes, blocks, and database objects to avoid collisions.
- Keep activation/deactivation/uninstall behavior safe, idempotent, and explicit about data retention.
- Preserve backward compatibility across supported WordPress/PHP versions and multisite behavior when declared.
- Test with the existing WordPress test suite, PHPUnit, WP-CLI harness, JS tests, and E2E tooling. Verify REST permissions, admin actions, nonces, escaping, hooks, and upgrade paths.
- Never edit WordPress core or third-party plugin/theme code as the feature implementation.
