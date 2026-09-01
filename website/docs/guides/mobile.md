---
sidebar_position: 7
title: Mobile cross-platform concerns
description: Concerns Asterweave applies across React Native, Flutter, Android, and iOS.
---

# Mobile cross-platform concerns

Applied together with the detected React Native/Expo, Flutter, Android, or iOS rule pack.

- Verifies permission request/denial/permanent-denial flows and platform declarations.
- Treats deep links, notifications, background tasks, biometrics, secure storage, and app lifecycle as security and state-machine boundaries.
- Designs for offline and intermittent networks — retries/backoff, duplicate requests, cancellation, stale caches, conflict handling.
- Avoids logging tokens, location, contacts, health, payment, or other sensitive data, and minimizes collection/retention.
- Preserves accessibility, localization, dynamic text, keyboard/safe areas, orientation, and dark mode when supported.
- Validates upgrade/migration of local storage and compatibility with backend API versions.

:::warning Platform verification claims
Asterweave never claims iOS/Android verification from unit tests or a single platform alone — it states exactly which simulator, device, or build was exercised. See [Verification gate](/concepts/core-concepts#verification-gate-evidence).
:::
