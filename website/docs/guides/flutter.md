---
sidebar_position: 6
title: Flutter and Dart
description: What Asterweave applies automatically for Flutter/Dart repositories.
---

# Flutter and Dart

Uses the detected Flutter/Dart SDK constraints, dependency lock, analysis options, state/navigation architecture, platform folders, and repository conventions.

- Preserves the existing widget/state-management pattern rather than introducing another state library.
- Keeps build methods side-effect free; disposes controllers, focus nodes, streams, subscriptions, timers, and animations.
- Models loading, empty, error, offline, retry, and permission states explicitly.
- Preserves null safety, immutable models where established, serialization contracts, localization, theming, and accessibility/semantics.
- Treats native plugin/config changes, permissions, signing, entitlements, and Gradle/Pod changes as explicit plan items requiring approval.

## Tests and gates

Unit-tests domain/state logic; widget-tests interactions, semantics, and navigation; integration-tests critical device flows and platform plugins. Golden tests are used only when the repository already has stable golden infrastructure. Candidate commands: `flutter pub get`, `dart format --output=none --set-exit-if-changed .`, `flutter analyze`, `flutter test`, and existing integration/platform build commands already supported by CI.

:::note Platform build limits
On Windows, iOS compilation/signing requires macOS or a remote CI/build service — Asterweave distinguishes local source validation from actual iOS build evidence rather than claiming both.
:::
