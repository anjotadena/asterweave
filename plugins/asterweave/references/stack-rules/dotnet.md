# .NET, ASP.NET Core, WPF, and Windows Forms

Use only after detecting .NET. Repository rules and existing architecture override this fallback.

## Implementation

- Respect solution/project boundaries, target framework, nullable context, analyzers, editorconfig, DI lifetime, and existing architecture (vertical slice, layered, DDD, Clean Architecture, or otherwise).
- Prefer async end to end for I/O and propagate `CancellationToken`. Avoid sync-over-async.
- Validate at the existing boundary; keep authorization server-side and resource-specific.
- Preserve API contracts and ProblemDetails/error conventions. Do not expose exception details.
- Use EF Core projections, bounded queries, no accidental client evaluation or N+1 loading, transactions for multi-write invariants, and reviewed migrations/indexes.
- Avoid static mutable state, service locator, broad repositories, unnecessary interfaces, and premature abstractions.
- Use structured logging without secrets/PII and existing telemetry/activity conventions.

## Web/API testing

- Follow xUnit/NUnit/MSTest already used. Reuse builders/fixtures and WebApplicationFactory/test hosts.
- Unit-test domain rules and validators; integration-test routes, auth, serialization, persistence, middleware, and external contracts.
- Verify status codes, headers, ProblemDetails, tenant/object authorization, idempotency, and cancellation/timeouts.

## WPF/Windows Forms

- Preserve UI-thread affinity and existing MVVM/event patterns. Avoid blocking the UI thread.
- Keep business logic outside code-behind/event handlers where the repository already separates it.
- Dispose components, timers, subscriptions, handles, and cancellation sources.
- Test view models/presenters/services; add UI automation only where the existing harness supports it.
- Verify DPI/scaling, keyboard focus/navigation, localization, long-running operations, cancellation, and error display.

## Candidate gates

Use the solution/project selected by repository docs or CI:

```text
dotnet restore <solution>
dotnet build <solution> --no-restore
dotnet test <solution> --no-build
dotnet format <solution> --verify-no-changes
```

Do not add `--no-restore` or `--no-build` unless the corresponding prior step completed for the same inputs/configuration.
