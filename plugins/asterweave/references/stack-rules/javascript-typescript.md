# JavaScript and TypeScript stacks

Use only after detecting the relevant framework. Lockfile, package manager, repository scripts, lint/format config, tsconfig, and existing architecture are authoritative.

## Universal rules

- Keep strict typing; avoid `any`, unsafe assertions, and type suppression unless documented and tested.
- Validate untrusted data at runtime. TypeScript types do not validate network/storage input.
- Preserve async error/cancellation/timeout behavior. Clean up subscriptions, effects, listeners, timers, requests, and resources.
- Do not mix package managers or regenerate a lockfile accidentally. Do not run forced audit upgrades.
- Preserve accessibility, localization, responsive behavior, SSR/hydration, and browser/device support where applicable.
- Test observable behavior; avoid brittle implementation assertions and indiscriminate snapshots.

## Angular

- Follow detected Angular version and existing standalone/module, signals/RxJS, state, routing, forms, DI, change-detection, template control-flow, and style conventions.
- Prefer `OnPush`/signals only when consistent with the codebase; do not convert unrelated code.
- Avoid nested subscriptions and unmanaged side effects. Preserve MSAL/auth guard and interceptor contracts.
- Unit-test components/services/pipes/guards; integration/E2E-test routing, forms, auth, and important user flows.

## React, Next.js, and React Native/Expo

- Preserve server/client boundaries, rendering strategy, state/cache library, navigation, and component composition patterns.
- Keep effects minimal with correct cleanup/dependencies. Avoid duplicating server state in local state.
- Preserve stable list keys, accessibility roles/labels, loading/error/empty states, and optimistic rollback.
- React Native: use platform APIs safely, respect permissions, offline/retry behavior, deep links, keyboard/safe areas, app lifecycle, and platform-specific files.
- Test hooks/components and data behavior; verify real navigation and critical browser/device flows.

## Node, Express, NestJS

- Keep controllers/routes thin and validation/auth at boundaries. Preserve DI/module conventions.
- Bound payloads, timeouts, retries, concurrency, and background jobs. Ensure idempotency where requests/jobs may repeat.
- Avoid leaking stack traces or sensitive logs. Handle shutdown and resource cleanup.
- Integration-test HTTP/queue/database contracts and auth, not only service methods.

## Electron

- Keep context isolation enabled, expose a narrow validated preload API, and avoid renderer Node integration.
- Treat IPC as an untrusted boundary. Validate channel payloads and authorize filesystem/process access.

## Candidate gates

Use only scripts that exist in the nearest `package.json`: restore with the detected locked mode, then `build`, typecheck, lint, unit, integration, and E2E scripts. Inspect script bodies before running them.
