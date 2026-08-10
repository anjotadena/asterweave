# Mobile cross-platform and native concerns

Apply with the detected React Native/Expo, Flutter, Android, or iOS rule pack.

- Verify permission request/denial/permanent-denial flows and platform declarations.
- Treat deep links, notifications, background tasks, biometrics, secure storage, files/media, and app lifecycle as security and state-machine boundaries.
- Design for offline, intermittent networks, retries/backoff, duplicate requests, cancellation, stale caches, and conflict handling.
- Avoid logging tokens, location, contacts, health, payment, or other sensitive data. Minimize collection and retention.
- Preserve accessibility, localization, dynamic text, keyboard/safe areas, orientation, responsive devices, and dark mode when supported.
- Validate upgrade/migration of local storage and compatibility with backend API versions.
- Test business/state logic, component/widget behavior, native bridges/plugins, navigation/deep links, and critical flows on supported platform builds or CI/device farms.
- Do not claim iOS/Android verification from unit tests or one platform alone. State exactly which simulator/device/build was exercised.
