# Conversation Lifecycle Refactor Design

**Date:** 2026-09-02

**Status:** Design decisions approved; written specification awaiting final review

**Scope:** Phase 0 and Phase 1 for unbound conversations

## Problem

Conversation behavior is currently spread across HTTP routes, dispatch code,
runtime-specific synchronization, management services, the Hive repository, and
the large conversation UI. A small change such as adding model or reasoning
settings can therefore touch many unrelated surfaces. The repeated failure mode
is not merely large files: multiple parts of the system know how to change the
same lifecycle state, so changing one path can silently invalidate another.

Concrete current seams include:

- `lib/conversation-dispatcher.ts`, where a user Entry, response placeholder,
  and dispatch Job are created by separate operations;
- `lib/codex-conversation.ts` and `lib/codex-sync-worker.ts`, which reconcile
  Codex-native activity with persisted conversation state;
- `lib/conversation-management.ts`, which coordinates native side effects with
  local rename, archive, and delete writes;
- `lib/conversation.ts` and other workflow-oriented services, which also write
  Conversation Entries;
- `lib/hive-memory/repository.ts`, which exposes the low-level writes and queue
  operations used by all of these callers;
- `components/task-conversation.tsx`, which consumes several overlapping
  lifecycle and live-update signals.

The design makes lifecycle ownership deep and explicit before attempting broad
file decomposition. Feature-oriented folders alone would move the ambiguity;
they would not remove competing writers or define transaction boundaries.

## Decision summary

Introduce a deep **Conversation Lifecycle Module** as the sole writer for the
in-scope unbound Conversation lifecycle. Existing routes, dispatch drivers,
Codex synchronization, and Runtime integrations become drivers or adapters that
submit commands and normalized outcomes. They do not decide or persist core
state transitions themselves.

Phase 0 first creates a feature matrix and characterization tests. Phase 1 then
migrates unbound conversations behind the Module without changing product
behavior, HTTP response shapes, UI structure, or the SQLite schema.

The first migration is deliberately a tracer bullet. The Interface must be
usable by future project/workflow-bound conversations, but those conversations
are not migrated in Phase 1.

## Goals

1. Give one Module authority over unbound Conversation and Turn invariants.
2. Make Entry-pair and Execution Job changes atomic where SQLite can provide
   that guarantee.
3. Preserve current product behavior and external contracts.
4. Make Codex, Lucky, and OpenClaw execution paths report outcomes through one
   lifecycle boundary without redesigning their Runtime implementations.
5. Detect new direct writers automatically.
6. Make each migration step independently testable, reviewable, and reversible.

## Non-goals

- Migrating project/workflow-bound conversations in Phase 1.
- Splitting or redesigning `TaskConversation`.
- Redesigning the existing provider execution seam or Agent Profile model.
- Introducing a separate Live Projection Module.
- Changing the SQLite schema.
- Changing UI behavior, labels, layout, HTTP status codes, or response shapes.
- Exposing or naming a Runtime's private implementation details in the domain
  model. Lucky is represented only as **Lucky Runtime**.
- Claiming exactly-once behavior across a remote Runtime and SQLite.

## Ubiquitous language

Canonical terms live in `CONTEXT.md`. The important distinctions are:

| Term | Meaning |
| --- | --- |
| Conversation | Durable interaction identity and active/archived metadata |
| Turn | One operator request and its response lifecycle |
| Conversation Entry | Persisted user/agent/manager/system record |
| Execution Job | Internal queue and lease record used to execute a Turn |
| Provider Outcome | Normalized result submitted by a Runtime adapter |
| Provider Telemetry | Availability/mapping state, independent of Turn state |
| Agent Profile | Jormungand-visible identity and routing metadata |
| Runtime | The execution boundary selected by an Agent Profile |

These are intentionally separate. In particular, a Runtime becoming offline
does not itself move a Turn to `failed`, and an Execution Job lease expiring is
not automatically a user-visible terminal result.

## State model

The design uses four orthogonal axes instead of one overloaded status:

### Conversation lifecycle

`active | archived`

Only an active Conversation may accept a new Turn. Archive state does not
rewrite historical Turn or Entry state.

### Turn and Entry lifecycle

`queued | running | completed | interrupted | canceled | failed`

The user Entry and response placeholder represent one logical Turn. Phase 1
preserves their existing persisted representation but makes their coordinated
transition an invariant of the Lifecycle Module.

Terminal Turn states are `completed`, `interrupted`, `canceled`, and `failed`.
A terminal Turn cannot be overwritten by a late or duplicate Runtime outcome.
An explicit retry is a new attempt/Turn under a deliberate command; it is not an
implicit reversal of a terminal state.

### Execution Job lifecycle

The existing queue owns queued/running/lease/recovery mechanics. It is internal
execution state, not the UI lifecycle model. Conversation-specific Job changes
are coordinated with Entry changes by the Lifecycle Module.

### Provider telemetry

Codex mapping and synchronization state, OpenClaw session state, Runtime
availability, and similar telemetry remain provider-specific. Adapters may use
telemetry to produce a normalized outcome, but telemetry cannot directly write
Conversation or Turn state.

## Module boundary

### Owned by Conversation Lifecycle Module

- command validation and authorization-independent domain preconditions;
- Conversation-active checks;
- legal Turn transition decisions;
- user Entry, response placeholder, and conversation Execution Job consistency;
- idempotency behavior;
- lease-aware claim/start and terminal settlement;
- protection against duplicate and late outcomes;
- lifecycle persistence transactions;
- post-commit live-event publication requests;
- reconciliation entry points for known cross-system gaps.

### Drivers and adapters

The following surfaces call the Module but do not write in-scope core state:

- existing conversation HTTP routes;
- the conversation dispatch driver;
- Codex native synchronization;
- Codex, Lucky, and OpenClaw execution adapters;
- management services;
- live event publishing.

The low-level Hive repository remains an internal persistence adapter. It may
expose transaction-focused operations to the Lifecycle Module, but production
callers must not use those operations to bypass lifecycle policy.

### Conceptual command surface

Names may be refined during implementation planning, but responsibilities must
remain distinct:

- `SubmitTurn`: validate an active Conversation and atomically create the user
  Entry, response placeholder, and dispatch Job.
- `ClaimNextTurn`: atomically claim a Job lease and move the Entry pair from
  queued to running.
- `SettleTurn`: validate a normalized outcome and atomically settle both Entries
  and the Job.
- `StopTurn`: apply interrupt or cancellation rules and reject late settlement.
- `UpdateConversationSettings`: persist model/reasoning settings without
  rewriting Turn truth.
- management commands: coordinate rename/archive/unarchive/delete while
  preserving the current external-side-effect order and known crash gap.

The Module returns immutable command results or dispatch envelopes. It does not
expose persistence records for arbitrary mutation.

## Runtime placement

The refactor does not merge Runtime implementations:

- Codex profiles continue through the Codex Runtime and native sync driver.
- The Mavis/Lucky Agent Profile continues through Codex Device Ingress to Lucky
  Runtime.
- OpenClaw profiles continue through OpenClaw Runtime using their configured
  `mainAgent` identities.

Each path retains its current transport/session behavior and returns a
normalized Provider Outcome at the Lifecycle boundary. Runtime-private
implementation choices are deliberately absent from this architecture.

## Transaction and execution flow

No database transaction remains open across a Runtime/network call.

### TX1 — submit

Within one SQLite transaction:

1. Validate that the Conversation exists and is active.
2. Resolve the existing idempotency identity.
3. Insert the user Entry.
4. Insert the response placeholder.
5. Insert the conversation dispatch Job.

The existing queued HTTP response is returned after commit. Waking the worker is
best effort because the durable Job is already present.

### TX2 — claim and start

Within one SQLite transaction:

1. Recover eligible expired leases according to existing policy.
2. Select the next claimable conversation Job.
3. Claim its lease.
4. Move the Entry pair from queued to running.
5. Return an immutable dispatch envelope.

Only a successfully claimed Job may invoke a Runtime. Runtime execution happens
after TX2 commits.

### TX3 — settle

Within one SQLite transaction:

1. Load the claimed Job and current Entry pair.
2. Validate lease ownership and the requested transition.
3. Treat a duplicate terminal outcome as an idempotent no-op.
4. Update both Entries and the Job consistently.
5. Commit the durable result.

Live publication occurs after commit. Failure to publish does not roll back the
durable result; existing GET/polling behavior rehydrates the UI.

## Core invariants

1. One idempotency key resolves to one user Entry, response Entry, and
   conversation dispatch Job.
2. A partially created Turn is never visible after TX1 fails.
3. Only a claimed Job can move a Turn to running or invoke a Runtime.
4. A terminal Turn transition occurs at most once.
5. The Entry pair and corresponding Job are updated in the same lifecycle
   transaction for submit, claim/start, and settlement.
6. A duplicate command returns the established identities or current result.
7. A late Runtime outcome cannot overwrite interrupted, canceled, failed, or
   completed truth.
8. Provider telemetry cannot directly mutate core lifecycle state.
9. A live-event failure cannot invalidate a committed durable result.

## Failure and recovery semantics

| Failure | Durable result | Required behavior |
| --- | --- | --- |
| Duplicate submit | Existing Entry pair and Job remain unchanged | Return the same identities/result |
| SQLite failure during TX1 | Entire submission rolls back | Do not invoke a Runtime |
| Claim race | At most one lease owner wins | Losing claimant performs no Runtime call |
| Confirmed Runtime failure | Turn and Job settle as failed | Persist through TX3 |
| Process crash during Runtime call | Running lease eventually expires | Use existing session/idempotency recovery; do not blindly redeliver when delivery is unknown |
| Duplicate or late outcome | Existing terminal truth remains | Idempotent no-op or stable conflict result |
| Live/SSE publication failure | Durable truth remains committed | Rehydrate through existing GET/polling |
| Native management side effect succeeds but SQLite write fails | External and local state may temporarily diverge | Preserve current order; surface failure and reconcile explicitly |

### Known no-schema limitation

Rename, archive, unarchive, and delete may require a Codex-native side effect.
That remote effect and SQLite cannot be committed atomically. Without a durable
outbox, Phase 1 cannot guarantee exactly-once management operations across a
process crash. Phase 1 therefore:

- preserves the current side-effect order and external contract;
- characterizes the current failure behavior;
- exposes a reconciliation path where current capabilities allow it;
- does not claim to eliminate the crash gap.

Closing this gap is a later decision that requires permission for a schema
migration.

## Feature matrix

The Phase 0 matrix is the refactor's acceptance index. It is stored in the repo
and each row links to concrete characterization or contract tests.

| Capability | Entry / command | Invariant | Runtime path | Phase 0 evidence |
| --- | --- | --- | --- | --- |
| Create/open unbound Conversation | Existing routes | Active Conversation accepts Turn | None | Route and repository characterization |
| Update model/reasoning | Settings command | Existing terminal Turn truth is unchanged | Applicable Agent Profile | HTTP contract and persistence assertion |
| Submit message | `SubmitTurn` | User + response + Job are created atomically | All profiles | Idempotency and rollback characterization |
| Claim/start | `ClaimNextTurn` | Only claimed Job reaches running | Dispatcher | Concurrency and lease contract |
| Complete/fail | `SettleTurn` | Entry pair + Job settle consistently | Normalized outcome | Transition table and duplicate outcome tests |
| Interrupt/cancel | `StopTurn` | Terminal once; late outcome cannot overwrite | Existing stop paths | Race characterization |
| Reconnect/rehydrate | Existing GET/polling | SQLite is durable truth | SSE is best effort | Rehydration integration test |
| Rename/archive/unarchive/delete | Existing management routes | Existing behavior and crash gap are preserved | Native thread where applicable | Current behavior and reconciliation characterization |

Every matrix row records:

- user-visible behavior;
- HTTP entry point and response contract;
- lifecycle command and legal transitions;
- persistence changes;
- Runtime path, if any;
- live/projection behavior;
- current characterization test;
- target contract test;
- known exception or deferred risk.

## Validation gates

### Gate 1 — lifecycle contracts

- table-driven legal and illegal Turn transitions;
- terminal-once behavior;
- duplicate command and outcome idempotency;
- no Runtime dependency in pure transition tests.

### Gate 2 — persistence contracts

- TX1, TX2, and TX3 atomicity;
- deterministic failure injection and rollback assertions;
- competing claimant behavior;
- lease-owner validation;
- Entry-pair and Job consistency after every error branch.

Tests use isolated SQLite databases and controllable time where lease behavior
is involved. They assert durable records, not only returned values.

### Gate 3 — compatibility and ownership

- snapshots/assertions for existing HTTP status and response shapes;
- outcome-contract tests for Codex, Lucky, and OpenClaw paths;
- current UI structure and live-rehydration tests remain green;
- a static architecture test rejects new direct production calls to in-scope
  Conversation/Entry/dispatch write methods.

Because workflow-bound migration is out of scope, the ownership test starts
with a named, auditable legacy allowlist for existing bound-workflow writers.
The allowlist may only shrink. New direct writers and all migrated unbound
paths fail the gate. This is the temporary bridge between the Phase 1 tracer
bullet and eventual system-wide single-writer ownership.

### Repository-wide completion checks

After each narrow test set, run:

```text
npm test
npm run typecheck
npm run lint
npm run build
```

No next migration slice begins while an affected feature-matrix row is red.

## Migration sequence

The implementation plan will name exact files and commands. Its commit units
must preserve the following sequence:

1. **Lock current unbound behavior.** Add the durable feature matrix and missing
   characterization tests. Make no production behavior changes.
2. **Make transitions executable contracts.** Introduce command/outcome types
   and pure lifecycle transition rules behind unused or read-only seams.
3. **Make submission atomic.** Add the TX1 repository operation and route only
   unbound `SubmitTurn` through it without changing HTTP output.
4. **Make claim/start atomic.** Add TX2 and move the unbound dispatch claimant
   behind the Module.
5. **Make settlement atomic.** Add TX3 for complete/fail and then interrupt/
   cancel, including duplicate and late-outcome behavior.
6. **Migrate existing unbound callers one seam at a time.** Move the conversation
   route and dispatcher first, then Codex sync, Lucky, and OpenClaw outcome
   paths. Each Runtime path gets an isolated commit and contract tests.
7. **Migrate unbound settings and management commands.** Preserve current model,
   reasoning, rename, archive, unarchive, and delete contracts, including the
   documented external-side-effect gap.
8. **Enforce ownership.** Add the shrinking legacy allowlist, reject new direct
   writers, and remove obsolete unbound write paths.
9. **Run the full matrix and record residual risk.** Complete the repository-wide
   checks and update the matrix with final evidence.

Each commit must be independently green and revertible. A commit must not mix a
lifecycle migration with UI decomposition, schema work, or provider redesign.

## Rollout and observability

This is an in-place local refactor, not a dual-write migration. Existing durable
records remain readable because the schema and external representations do not
change.

During migration, logs and tests must make these identities traceable together:

- Conversation ID;
- Turn/user Entry/response Entry identities;
- dispatch Job ID and idempotency key;
- lease owner and attempt where applicable;
- selected Agent Profile and Runtime path;
- normalized terminal outcome.

Do not log credentials, bridge tokens, or raw private Runtime state.

## Deferred work

- migrate project/workflow-bound conversations and remove the legacy writer
  allowlist;
- introduce a durable outbox if atomic native-management intent is approved;
- extract a Live Projection Module after lifecycle truth is stable;
- split `TaskConversation` by behavior once its inputs come from one lifecycle
  model;
- reconsider provider Interface depth only after all Runtime paths use the same
  outcome boundary.

## Acceptance criteria

Phase 0 and Phase 1 are complete only when:

1. The feature matrix covers every listed capability and links to passing
   evidence.
2. Unbound submit, claim/start, settle, interrupt, cancel, and fail transitions
   pass lifecycle and transaction contract tests.
3. Codex, Lucky, and OpenClaw unbound execution preserve their current external
   behavior while reporting outcomes through the Module.
4. Existing HTTP, UI, SQLite schema, and persisted-data compatibility remain
   unchanged.
5. New direct unbound core-state writers fail the static ownership gate, and the
   workflow-bound legacy allowlist has not grown.
6. Known native-management crash gaps are characterized and documented without
   being misrepresented as solved.
7. Tests, typecheck, lint, and production build pass.

## Decision record

- Chosen: deepen the Conversation Lifecycle Module before reorganizing files by
  feature.
- Chosen: use unbound conversations as the tracer bullet.
- Chosen: strict single-writer ownership for migrated paths with a shrinking,
  explicit exception list for deferred workflow-bound migration.
- Chosen: preserve UI, HTTP, and schema contracts in Phase 1.
- Rejected: broad folder-by-feature rewrite, because it does not establish
  lifecycle authority or transactional consistency.
- Rejected: splitting `TaskConversation` in the same phase, because it would mix
  projection risk with durable-state migration.
- Rejected: schema/outbox work in Phase 1, because the approved scope requires
  a no-schema-change tracer bullet.
- Rejected: exposing Runtime-private implementation details as architecture or
  domain language.
