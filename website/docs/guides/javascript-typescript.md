---
sidebar_position: 2
title: Angular, React, Node, Next, Nest, Electron
description: What Asterweave applies automatically across JavaScript/TypeScript stacks.
---

# JavaScript and TypeScript stacks

Applied only after Asterweave detects the relevant framework. The lockfile, package manager, repository scripts, lint/format config, `tsconfig`, and existing architecture are always authoritative.

## Universal rules

- Keeps strict typing; avoids `any`, unsafe assertions, and type suppression unless already documented and tested.
- Validates untrusted data at runtime — TypeScript types don't validate network/storage input.
- Preserves async error/cancellation/timeout behavior and cleans up subscriptions, effects, listeners, timers, requests, and resources.
- Never mixes package managers or regenerates a lockfile accidentally, and never runs a forced audit upgrade.

## Angular

Follows the detected Angular version and existing standalone/module, signals/RxJS, state, routing, forms, DI, and change-detection conventions; avoids nested subscriptions and unmanaged side effects; preserves auth guard/interceptor contracts.

## React, Next.js, React Native/Expo

Preserves server/client boundaries, rendering strategy, state/cache library, navigation, and component composition; keeps effects minimal with correct cleanup/dependencies; preserves accessibility roles/labels and loading/error/empty states. For React Native: respects platform permissions, offline/retry behavior, deep links, and platform-specific files.

## Node, Express, NestJS

Keeps controllers/routes thin with validation/auth at the boundary; bounds payloads, timeouts, retries, and concurrency; ensures idempotency where requests/jobs may repeat; avoids leaking stack traces or sensitive logs.

## Electron

Keeps context isolation enabled, exposes a narrow validated preload API, avoids renderer Node integration, and treats IPC as an untrusted boundary requiring payload validation.

## Candidate quality gates

Only scripts that already exist in the nearest `package.json` — restore with the detected locked install mode, then build, typecheck, lint, unit, integration, and E2E scripts, with script bodies inspected before running.
