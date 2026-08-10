# Flutter and Dart

Use the detected Flutter/Dart SDK constraints, dependency lock, analysis options, state/navigation architecture, platform folders, and repository conventions.

- Preserve widget/state-management patterns; do not introduce another state library.
- Keep build methods side-effect free. Dispose controllers, focus nodes, streams, subscriptions, timers, and animations.
- Model loading, empty, error, offline, retry, and permission states explicitly.
- Preserve null safety, immutable models where established, serialization contracts, localization, theming, accessibility/semantics, responsive layout, and platform differences.
- Validate deep links, app lifecycle/resume, background behavior, storage, networking timeouts/cancellation, and secure credential storage.
- Treat native plugin/config changes, permissions, signing, entitlements, Gradle/Pod changes, and generated files as explicit plan items.

## Tests and gates

- Unit-test domain/state logic; widget-test interactions, semantics, layout states, and navigation; integration-test critical device flows and platform plugins.
- Use golden tests only when the repository has stable golden infrastructure; review intentional pixel changes.
- Candidate commands: `flutter pub get`, `dart format --output=none --set-exit-if-changed .`, `flutter analyze`, `flutter test`, existing integration-test commands, and platform builds supported by CI.
- On Windows, iOS compilation/signing requires macOS or a remote CI/build service; distinguish local source validation from actual iOS build evidence.
