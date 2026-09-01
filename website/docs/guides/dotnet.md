---
sidebar_position: 1
title: .NET, ASP.NET Core, WPF, Windows Forms
description: What Asterweave applies automatically once it detects a .NET stack.
---

# .NET, ASP.NET Core, WPF, Windows Forms

Applied only after Asterweave detects .NET. Repository rules and existing architecture always override this fallback pack.

## Implementation

- Respects solution/project boundaries, target framework, nullable context, analyzers, editorconfig, DI lifetime, and whatever architecture is already there (vertical slice, layered, DDD, Clean Architecture, or otherwise).
- Prefers async end to end for I/O, propagating `CancellationToken`; avoids sync-over-async.
- Validates at the existing boundary; keeps authorization server-side and resource-specific.
- Preserves API contracts and `ProblemDetails`/error conventions; never exposes exception details.
- Uses EF Core projections and bounded queries, avoids accidental client evaluation or N+1 loading, wraps multi-write invariants in transactions, and reviews migrations/indexes.
- Avoids static mutable state, service locators, broad repository abstractions, and premature interfaces.

## WPF / Windows Forms

Preserves UI-thread affinity and existing MVVM/event patterns, keeps business logic outside code-behind where the repository already separates it, and disposes components/timers/subscriptions/handles.

## Testing

Follows whichever of xUnit/NUnit/MSTest the repository already uses, reusing builders/fixtures and `WebApplicationFactory`/test hosts. Unit-tests domain rules and validators; integration-tests routes, auth, serialization, persistence, and external contracts.

## Candidate quality gates

Discovered from the repository's own solution/project references, typically:

```bash
dotnet restore <solution>
dotnet build <solution> --no-restore
dotnet test <solution> --no-build
dotnet format <solution> --verify-no-changes
```

`--no-restore`/`--no-build` are only added when the corresponding prior step actually completed for the same inputs and configuration.
