# Runtime Boundary Hardening Design

**Date:** 2026-08-20

## Goal

Make the Jormungand runtime boundaries explicit so workflow state, Hive memory,
health reporting, and browser/runtime surfaces all resolve from a single
configured data root instead of a mix of implicit working-directory paths and
environment defaults.

## Scope

This change hardens the data and execution boundaries around the current local
runtime:

- one configured `JORMUNGAND_DATA_DIR` root for workflow state and Hive data
- one-time legacy state migration into the configured root
- API-owned auth, validation, state transitions, and job creation
- worker-owned long-running execution
- browser-safe bundles that never receive bridge tokens or Node-only imports
- service split readiness only when an external shared database and queue exist

## Current constraints

The current app still spreads durable state across a working-directory-relative
workflow file and a Hive SQLite file that defaults to the same working
directory when `JORMUNGAND_DATA_DIR` is unset. That makes the runtime boundary
implicit, makes migration rules harder to reason about, and leaves room for
browser and worker code to depend on the wrong execution context.

The new boundary contract keeps local development simple, but it makes the
storage root and the execution authority explicit so the runtime can be moved,
split, or audited without guessing where state lives.

## Architecture

### Single data root

`JORMUNGAND_DATA_DIR` is the only configured root for durable workflow and Hive
storage.

The runtime resolves both paths from that root:

- workflow state file
- Hive SQLite database

The resolver must be injectable from env input so tests and callers can supply
an isolated data directory without mutating process-global state.

### One-time legacy migration

If legacy workflow state exists at the old location, the runtime copies it into
the configured data root once.

Migration is non-overwriting:

- an existing configured workflow state always wins over legacy data
- legacy data may seed the new location, but it must not replace newer
  configured state
- the copy should be idempotent so repeated startup does not churn the file

### Boundary ownership

The API owns:

- authentication
- input validation
- workflow state transitions
- job creation and dispatch decisions

Workers own:

- long-running execution
- result production
- writing back through the explicit persistence boundary

Browser code must remain browser-safe:

- no bridge tokens in browser bundles
- no Node-only imports in browser bundles
- no accidental dependency on server filesystem helpers

### Split-service readiness

This runtime stays a single local system until the external dependencies exist
to support a real split:

- a shared database that both API and workers can see
- a queue that can carry job handoff and recovery state across processes

Without both pieces, service splitting would just move the boundary problem
around instead of fixing it.

## Acceptance criteria

1. `JORMUNGAND_DATA_DIR` is the single configured root for workflow state and
   Hive data.
2. Legacy workflow state is copied into the configured root once, and a newer
   configured workflow state is never overwritten by legacy data.
3. API routes own auth, validation, transitions, and job creation.
4. Workers own long-running execution and do not inherit browser-only
   constraints.
5. Browser bundles never receive bridge tokens or Node-only imports.
6. A service split is only considered supported once an external shared
   database and queue are available.
