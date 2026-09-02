# Conversation Lifecycle Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan. Track every step with the checkboxes below and stop a slice whenever its affected feature-matrix row is red.

**Goal:** Make the Conversation Lifecycle Module the sole writer of unbound Conversation, Turn, Conversation Entry, and conversation Execution Job state while preserving the current HTTP, UI, SQLite, and Runtime behavior.

**Architecture:** Add a deep, runtime-neutral lifecycle module in front of transaction-focused Hive repository operations. The module owns legal transitions and TX1 submit, TX2 claim/start, TX3 settle, stop, settings, management writes, and reconciliation. HTTP routes, the dispatcher, Codex synchronization, Lucky Runtime routing, and OpenClaw routing remain drivers/adapters. Project/workflow-bound writers stay on an explicit shrinking legacy allowlist in Phase 1.

**Tech Stack:** TypeScript, Next.js 16 route handlers, Node test runner, better-sqlite3, existing Hive repository, existing Codex/Lucky Runtime/OpenClaw adapters, ESLint, and Turbopack production build. No new dependency and no SQLite schema migration.

---

## Starting point

This plan starts after the two baseline-repair commits on `codex/conversation-lifecycle-refactor`:

- `b717c00` restores durable workflow job envelopes, idempotency headers, fixed human approval policy, and the independent monitoring rail.
- `0d42db3` aligns stale tests with the accepted Lucky roster, schema v10 fixtures, current activity placement, quota mapping, and order-independent native sync behavior.

Baseline evidence recorded before this plan:

- `npm test`: 487 passed, 0 failed.
- `npm run typecheck`: exit 0.
- `npm run lint`: 0 errors, 15 pre-existing warnings.
- `npm run build`: exit 0.

Generated `.harness/superpowers-catalog/` and `data/` directories are test/runtime output. Never stage them.

## Scope locks

- Phase 1 owns unbound IDs (`conversation:*` and the legacy unbound identity) only.
- Do not migrate project/workflow-bound conversation behavior.
- Do not split `components/task-conversation.tsx` or alter UI layout, copy, controls, polling intervals, or SSE shapes.
- Do not change route status codes or JSON field names.
- Do not change `lib/hive-memory/schema.ts` or increment `hiveSchemaVersion`.
- Do not redesign Agent Profiles, bridge transports, authentication, or session derivation.
- Use only the architecture term **Lucky Runtime**. Do not expose Runtime-private implementation details in code comments, docs, tests, or names.
- Do not hold a SQLite transaction open while awaiting a Runtime or network call.

## Target file map

- Create `docs/superpowers/evidence/2026-09-02-conversation-lifecycle-feature-matrix.md`: acceptance index linking every capability to current and target evidence.
- Create `lib/conversation-lifecycle/types.ts`: command, outcome, aggregate, notification, and port types.
- Create `lib/conversation-lifecycle/transitions.ts`: pure legal-transition and terminal-once rules.
- Create `lib/conversation-lifecycle/service.ts`: deep command boundary and post-commit coordination.
- Modify `lib/hive-memory/repository.ts`: connection-scoped primitives plus TX1/TX2/TX3 and management persistence operations.
- Modify `lib/conversation-dispatcher.ts`: unbound driver using the lifecycle module; retained bound path stays explicit legacy code.
- Modify `lib/conversation.ts`: unbound submission uses lifecycle commands; bound service behavior remains unchanged.
- Modify `lib/hive-services.ts`: construct one lifecycle service and inject it into drivers.
- Modify `lib/codex-conversation.ts`: provider telemetry remains local; core Entry/Turn reconciliation calls lifecycle commands.
- Modify `lib/codex-sync-worker.ts`: inject the lifecycle-aware Codex synchronization function.
- Modify `lib/conversation-management.ts`: retain validation and native side-effect ordering, but delegate local writes to lifecycle commands.
- Modify conversation route handlers under `app/api/conversation/` and `app/api/conversations/`: keep contracts, remove direct core writes.
- Create `tests/conversation-lifecycle-characterization.test.ts`: Phase 0 HTTP/runtime/management behavior locks.
- Create `tests/conversation-lifecycle-transitions.test.ts`: pure transition table.
- Create `tests/conversation-lifecycle-repository.test.ts`: TX1/TX2/TX3 atomicity and race tests.
- Create `tests/conversation-lifecycle-service.test.ts`: command orchestration, post-commit, stop, and reconciliation tests.
- Create `tests/conversation-lifecycle-ownership.test.ts`: TypeScript-AST writer gate and shrinking bound-writer allowlist.
- Modify existing conversation, queue, Codex sync, management, route, and UI contract tests only where they move to the new boundary.

## Standard green gate

Run this gate after every task and before its commit:

```powershell
Set-Location repos/jormungand
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected throughout: 0 test failures, typecheck exit 0, lint 0 errors, build exit 0, and no whitespace errors. Existing lint warnings may remain but must not increase.

## Task 1: Build the Phase 0 feature matrix and missing characterization evidence

**Files:**

- Create: `repos/jormungand/docs/superpowers/evidence/2026-09-02-conversation-lifecycle-feature-matrix.md`
- Create: `repos/jormungand/tests/conversation-lifecycle-characterization.test.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-structure.test.ts`
- Modify: `repos/jormungand/tests/conversation-management.test.ts`

- [ ] **Step 1: Write the matrix before production changes.**

Create one row for each accepted capability: create/open, settings, submit, claim/start, complete/fail, interrupt/cancel, reconnect/rehydrate, rename, archive/unarchive, and delete. Use these columns:

```markdown
| Capability | HTTP/driver entry | Current writer(s) | Durable records | Runtime path | Current evidence | Target evidence | Phase 1 exception/risk |
```

Link current evidence to exact test names in:

- `tests/conversation-lifecycle-structure.test.ts`
- `tests/conversation-queue.test.ts`
- `tests/conversation.test.ts`
- `tests/conversation-management.test.ts`
- `tests/codex-native-conversation-sync.test.ts`
- `tests/conversation-live-route.test.ts`
- `tests/conversation-ui-behavior.test.ts`
- `tests/conversation-ui-structure.test.ts`
- `tests/execution-jobs.test.ts`

Record two known exceptions explicitly: workflow-bound writers are deferred, and native management side effects cannot be atomic with SQLite without an outbox/schema change.

- [ ] **Step 2: Add exact queued POST and duplicate characterization tests.**

Use the route-fixture pattern already present in `conversation-lifecycle-structure.test.ts`. Assert a fresh POST remains HTTP 202, a duplicate remains HTTP 200, and both bodies retain the existing keys and identities:

```ts
assert.deepEqual(Object.keys(freshBody).sort(), [
  "conversationId",
  "duplicate",
  "jobId",
  "jobStatus",
  "responseEntry",
  "status",
  "userEntry"
].sort())
assert.equal(duplicateBody.userEntry.id, freshBody.userEntry.id)
assert.equal(duplicateBody.responseEntry.id, freshBody.responseEntry.id)
assert.equal(duplicateBody.jobId, freshBody.jobId)
```

Do not snapshot generated UUIDs or timestamps.

- [ ] **Step 3: Characterize all three Runtime paths without changing them.**

Add one table-driven test that invokes current unbound routing for `codex`, `mavis`, and `openclaw.rowlet`. Assert the selected Agent Profile reaches the invocation boundary, the same `conversationId` and idempotency key are preserved, and the returned `{ status, body }` shape is stable. Name the Mavis case “Lucky Runtime path”; do not name its private implementation.

- [ ] **Step 4: Characterize the native-management crash gap.**

Add a service test where `renameNativeThread` succeeds and the local repository rename throws. Assert the call rejects, the native call was observed once, and the local title remains unchanged. Add the inverse assertion that a native failure performs no local rename.

- [ ] **Step 5: Run the new Phase 0 tests.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="queued POST|duplicate submission|Runtime path|native rename" ".tmp-tests/tests/conversation-lifecycle-characterization.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/conversation-management.test.js"
```

Expected: PASS against the pre-refactor implementation. If a proposed assertion fails because it describes target behavior rather than current behavior, move it to the target-evidence column and a later RED test.

- [ ] **Step 6: Run the standard green gate and commit Phase 0.**

```powershell
git add -- docs/superpowers/evidence/2026-09-02-conversation-lifecycle-feature-matrix.md tests/conversation-lifecycle-characterization.test.ts tests/conversation-lifecycle-structure.test.ts tests/conversation-management.test.ts
git commit -m "Make current conversation behavior auditable before migration" -m "Record every Phase 1 capability against executable evidence and lock the external contracts that the single-writer refactor must preserve." -m "Constraint: No production behavior changes in Phase 0
Confidence: high
Scope-risk: narrow
Tested: standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 2: Make Turn transitions executable contracts

**Files:**

- Create: `repos/jormungand/lib/conversation-lifecycle/types.ts`
- Create: `repos/jormungand/lib/conversation-lifecycle/transitions.ts`
- Create: `repos/jormungand/tests/conversation-lifecycle-transitions.test.ts`

- [ ] **Step 1: Add a failing table-driven transition test.**

Cover every source state in `ConversationStatus`. Required rules:

```ts
const terminal = ["completed", "interrupted", "canceled", "failed"] as const

const legal = [
  ["queued", "running"],
  ["queued", "canceled"],
  ["queued", "failed"],
  ["running", "completed"],
  ["running", "interrupted"],
  ["running", "canceled"],
  ["running", "failed"]
] as const
```

Assert same-state duplicates are no-ops; any requested provider outcome after a terminal state is a stable late-outcome no-op; all other transitions throw `ConversationLifecycleError` with code `illegal_turn_transition`.

- [ ] **Step 2: Prove Pause is not a Turn terminal outcome.**

Add a type/behavior test for provider observations:

```ts
const paused = normalizeProviderObservation({
  kind: "progress",
  providerState: "paused",
  body: "Paused"
})
assert.equal(paused.turnTransition, undefined)
```

Only explicit Stop, confirmed failure, interruption, cancellation, or completion may request a terminal Turn status. This preserves Continue while retaining terminal-once.

- [ ] **Step 3: Run the RED test.**

```powershell
npx tsc -p tsconfig.tests.json
node --test ".tmp-tests/tests/conversation-lifecycle-transitions.test.js"
```

Expected: FAIL because `lib/conversation-lifecycle/types.ts` and `transitions.ts` do not exist.

- [ ] **Step 4: Implement the runtime-neutral types and pure rules.**

Define these stable shapes:

```ts
export type TurnStatus = ConversationStatus

export type ProviderOutcome =
  | { kind: "completed"; body: string; deliveryState: "confirmed" }
  | { kind: "interrupted"; body: string; deliveryState: "confirmed" }
  | { kind: "failed"; body: string; deliveryState: "confirmed" | "unknown" }

export interface TurnIdentity {
  conversationId: string
  userEntryId: string
  responseEntryId: string
  jobId: string
  idempotencyKey: string
}

export type TransitionDecision =
  | { kind: "apply"; next: TurnStatus }
  | { kind: "noop"; reason: "duplicate" | "terminal" }
```

Keep the transition functions pure: no repository, clock, bridge, environment, or live-bus imports.

- [ ] **Step 5: Run the focused test and standard green gate, then commit.**

```powershell
npx tsc -p tsconfig.tests.json
node --test ".tmp-tests/tests/conversation-lifecycle-transitions.test.js"
git add -- lib/conversation-lifecycle/types.ts lib/conversation-lifecycle/transitions.ts tests/conversation-lifecycle-transitions.test.ts
git commit -m "Prevent lifecycle paths from inventing their own terminal rules" -m "Centralize legal Turn transitions, duplicate handling, and late-outcome protection before persistence callers move behind the module." -m "Constraint: Pause remains provider telemetry, not a terminal Turn state
Confidence: high
Scope-risk: narrow
Tested: transition tests and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 3: Extract connection-scoped persistence primitives without behavior change

**Files:**

- Modify: `repos/jormungand/lib/hive-memory/repository.ts`
- Modify: `repos/jormungand/tests/hive-memory-repository.test.ts`
- Modify: `repos/jormungand/tests/execution-jobs.test.ts`

- [ ] **Step 1: Lock the existing primitive behavior.**

Run the current repository and job tests before editing:

```powershell
npx tsc -p tsconfig.tests.json
node --test ".tmp-tests/tests/hive-memory-repository.test.js" ".tmp-tests/tests/execution-jobs.test.js"
```

Expected: PASS. Save the test count in the task notes.

- [ ] **Step 2: Extract private helpers that accept a live SQLite connection.**

Add private methods with these responsibilities and no new public behavior:

```ts
private insertConversationOnConnection(
  connection: Database.Database,
  entry: ConversationEntry
): boolean

private insertExecutionJobOnConnection(
  connection: Database.Database,
  job: ExecutionJob
): boolean

private updateConversationOnConnection(
  connection: Database.Database,
  input: { id: string; content?: string; status?: ConversationStatus; artifactIds?: string[]; memoryIds?: string[] },
  updatedAt: string
): ConversationEntry | undefined
```

Make existing `insertConversation`, `createExecutionJob`, and `updateConversation` call the helpers inside their existing transaction boundaries. Preserve `INSERT OR IGNORE`, title derivation, metadata touching, JSON serialization, return values, and errors exactly.

- [ ] **Step 3: Add a rollback assertion for the extracted helper path.**

Retain and extend the existing metadata rollback test so an injected metadata-touch failure leaves neither the Entry nor a partial metadata timestamp update. This remains a green-to-green refactor test, not a new lifecycle contract.

- [ ] **Step 4: Re-run the focused tests.**

```powershell
npx tsc -p tsconfig.tests.json
node --test ".tmp-tests/tests/hive-memory-repository.test.js" ".tmp-tests/tests/execution-jobs.test.js"
```

Expected: the same tests and externally visible rows pass unchanged.

- [ ] **Step 5: Run the standard green gate and commit.**

```powershell
git add -- lib/hive-memory/repository.ts tests/hive-memory-repository.test.ts tests/execution-jobs.test.ts
git commit -m "Prepare one SQLite boundary for lifecycle transactions" -m "Reuse connection-scoped Entry and Job primitives so later TX1, TX2, and TX3 operations can be atomic without nesting repository transactions." -m "Constraint: This commit changes no public repository behavior
Confidence: high
Scope-risk: moderate
Tested: repository tests, execution-job tests, and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 4: Implement TX1 SubmitTurn atomically

**Files:**

- Create: `repos/jormungand/lib/conversation-lifecycle/service.ts`
- Create: `repos/jormungand/tests/conversation-lifecycle-repository.test.ts`
- Create: `repos/jormungand/tests/conversation-lifecycle-service.test.ts`
- Modify: `repos/jormungand/lib/hive-memory/repository.ts`

- [ ] **Step 1: Add failing TX1 rollback, active-state, and idempotency tests.**

Create an active `conversation:tx1` fixture. Add tests for:

- one call creates exactly one user Entry, one response placeholder, and one `conversation_dispatch` Job;
- duplicate and concurrent duplicate calls return the same three identities;
- a missing or archived Conversation is rejected before any Entry or Job is inserted;
- response insertion failure rolls back the user Entry;
- Job insertion failure rolls back both Entries.

Inject deterministic SQLite failure with a temporary trigger, then remove it in test cleanup:

```ts
await database.write((connection) => connection.exec(`
  CREATE TEMP TRIGGER fail_tx1_response
  BEFORE INSERT ON conversation_entries
  WHEN NEW.idempotency_key LIKE '%:response'
  BEGIN
    SELECT RAISE(ABORT, 'injected response failure');
  END;
`))
```

Use a second trigger on `execution_jobs` for the Job rollback case. Assert durable tables after rejection, not only the thrown error.

- [ ] **Step 2: Run TX1 RED.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="SubmitTurn|TX1" ".tmp-tests/tests/conversation-lifecycle-repository.test.js" ".tmp-tests/tests/conversation-lifecycle-service.test.js"
```

Expected: FAIL because `submitConversationTurn` and `ConversationLifecycleService.submitTurn` do not exist.

- [ ] **Step 3: Add the transaction-focused repository operation.**

Implement one `database.transaction` that:

1. Loads `conversations` and requires `state = 'active'`.
2. Resolves `${conversationId}:${idempotencyKey}`, `:response`, and `:dispatch` inside the transaction.
3. On a complete duplicate, returns the existing aggregate with `duplicate: true`.
4. On an incomplete duplicate, throws `incomplete_turn_record` without adding rows.
5. Inserts user Entry, response placeholder, and Job with the connection-scoped helpers.
6. Returns a `SubmittedTurn` aggregate only after commit.

Do not call another async repository method from inside the transaction callback.

- [ ] **Step 4: Add the deep command method.**

`ConversationLifecycleService.submitTurn` validates trimmed content, non-empty idempotency, target Agent Profile already selected by the driver, and response role. It then calls only `repository.submitConversationTurn` and returns immutable data:

```ts
export interface SubmittedTurn extends TurnIdentity {
  readonly userEntry: ConversationEntry
  readonly responseEntry: ConversationEntry
  readonly jobStatus: ExecutionJobStatus
  readonly duplicate: boolean
}
```

Map lifecycle errors to stable codes/statuses in the service, but do not import Next.js types.

- [ ] **Step 5: Run TX1 GREEN and the standard gate.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="SubmitTurn|TX1" ".tmp-tests/tests/conversation-lifecycle-repository.test.js" ".tmp-tests/tests/conversation-lifecycle-service.test.js"
```

Expected: all TX1 tests pass; no Runtime fake is needed because submission cannot invoke a Runtime.

- [ ] **Step 6: Commit TX1.**

```powershell
git add -- lib/conversation-lifecycle/service.ts lib/hive-memory/repository.ts tests/conversation-lifecycle-repository.test.ts tests/conversation-lifecycle-service.test.ts
git commit -m "Prevent partially submitted conversation turns" -m "Create the user Entry, response placeholder, and dispatch Job in one active-conversation transaction with stable duplicate identities." -m "Constraint: No Runtime call occurs in TX1
Confidence: high
Scope-risk: moderate
Directive: Never split SubmitTurn back into separate repository calls
Tested: TX1 failure injection, idempotency, concurrency, and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 5: Route unbound creation, settings, and submission through the module

**Files:**

- Modify: `repos/jormungand/lib/conversation-lifecycle/service.ts`
- Modify: `repos/jormungand/lib/conversation.ts`
- Modify: `repos/jormungand/lib/hive-services.ts`
- Modify: `repos/jormungand/app/api/conversation/route.ts`
- Modify: `repos/jormungand/app/api/conversation/new/route.ts`
- Modify: `repos/jormungand/app/api/conversations/route.ts`
- Modify: `repos/jormungand/tests/conversation.test.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-structure.test.ts`
- Modify: `repos/jormungand/tests/conversation-ui-behavior.test.ts`

- [ ] **Step 1: Add RED service and route assertions.**

Assert:

- body-less POST still creates/opens an active Conversation and returns 202;
- explicit unknown but valid unbound identity retains current create-on-first-use behavior;
- archived Conversation submit fails with a 409 JSON error and inserts nothing;
- model/reasoning updates still occur only for Codex and never rewrite existing Turn status;
- a duplicate still returns HTTP 200 and the exact established Entry/Job identities;
- project/workflow-bound route tests remain unchanged.

- [ ] **Step 2: Run the focused RED tests.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="active Conversation|archived Conversation|duplicate|selected model|reasoning" ".tmp-tests/tests/conversation.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/conversation-ui-behavior.test.js"
```

Expected: the archived assertion or lifecycle-spy assertion fails because the current route/service still writes through `ConversationQueueService` and repository methods.

- [ ] **Step 3: Add `openConversation` and `updateConversationSettings` commands.**

The commands own local writes and preserve current defaults:

```ts
await lifecycle.openConversation({
  conversationId: identity.conversationId,
  title: "New conversation"
})

await lifecycle.updateConversationSettings({
  conversationId,
  selectedModelId,
  selectedReasoningIntensity
})
```

`openConversation` returns existing metadata without resetting its title or archive state. New identities start active. `updateConversationSettings` updates only supplied fields and rejects missing/archived identities according to characterized behavior.

- [ ] **Step 4: Inject one lifecycle instance and preserve the HTTP envelope.**

Construct the service once in `createHiveServices`. Change `ConversationService.enqueueUnboundMessage` to call `lifecycle.submitTurn`; keep `enqueueMessage` and all project/workflow-bound behavior on the legacy queue. Keep the route response expression:

```ts
const response = NextResponse.json(result, {
  status: result.duplicate ? 200 : 202
})
```

Remove direct `repository.createConversation` from `app/api/conversation/route.ts`. Keep cookie rotation, allowed-agent validation, target normalization, and response fields unchanged.

- [ ] **Step 5: Delete the unused synchronous unbound writer.**

After `rg -n "postUnboundMessage" app lib` shows no production caller, delete `ConversationService.postUnboundMessage`. Move its useful Runtime-routing assertions to direct adapter tests or the queued submit/drain path. Do not delete the bound `postMessage` method in this phase.

- [ ] **Step 6: Run focused GREEN and the standard gate.**

```powershell
npx tsc -p tsconfig.tests.json
node --test ".tmp-tests/tests/conversation.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/conversation-ui-behavior.test.js"
```

Expected: existing response shapes, cookies, model/reasoning persistence, and UI payload tests pass; new archived-submit assertion passes.

- [ ] **Step 7: Commit the unbound ingress migration.**

```powershell
git add -- lib/conversation-lifecycle/service.ts lib/conversation.ts lib/hive-services.ts app/api/conversation/route.ts app/api/conversation/new/route.ts app/api/conversations/route.ts tests/conversation.test.ts tests/conversation-lifecycle-structure.test.ts tests/conversation-ui-behavior.test.ts
git commit -m "Give unbound submission one lifecycle authority" -m "Route conversation creation, settings, and SubmitTurn through the deep module while retaining current route and UI contracts." -m "Constraint: Workflow-bound submission remains deferred
Confidence: high
Scope-risk: moderate
Tested: ingress contract tests and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 6: Implement TX2 ClaimNextTurn and atomic start

**Files:**

- Modify: `repos/jormungand/lib/conversation-lifecycle/types.ts`
- Modify: `repos/jormungand/lib/conversation-lifecycle/service.ts`
- Modify: `repos/jormungand/lib/hive-memory/repository.ts`
- Modify: `repos/jormungand/lib/conversation-dispatcher.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-repository.test.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-service.test.ts`
- Modify: `repos/jormungand/tests/conversation-queue.test.ts`

- [ ] **Step 1: Add failing atomic-claim and competing-claimant tests.**

After submitting two Turns to one Conversation, assert:

- one claim changes the selected Job and both Entries from queued to running in one transaction;
- a second concurrent claimant receives no envelope while one Job is running;
- only after settlement may the next FIFO Turn be claimed;
- the immutable envelope contains job/lease, user Entry, response Entry, target Agent Profile, and original content;
- an expired lease is recovered using existing policy, with its Entry pair returned to queued before re-claim;
- malformed payload or missing Entry is failed inside TX2 and never reaches a Runtime fake.

- [ ] **Step 2: Run TX2 RED.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="ClaimNextTurn|TX2|competing claimant|expired lease|malformed dispatch" ".tmp-tests/tests/conversation-lifecycle-repository.test.js" ".tmp-tests/tests/conversation-lifecycle-service.test.js" ".tmp-tests/tests/conversation-queue.test.js"
```

Expected: FAIL because claim currently updates only `execution_jobs`; Entries are updated later by the dispatcher.

- [ ] **Step 3: Implement one connection-level claim/start transaction.**

Return this boundary type:

```ts
export interface TurnDispatchEnvelope extends TurnIdentity {
  readonly leaseOwner: string
  readonly leaseExpiresAt: string
  readonly attemptCount: number
  readonly targetAgent: AgentKind
  readonly content: string
  readonly userEntry: ConversationEntry
  readonly responseEntry: ConversationEntry
}
```

Inside one `database.transaction`: recover eligible conversation-dispatch leases, restore their nonterminal Entry pair to queued, reject another running Job for the Conversation, select FIFO Job, validate payload/pair/reply linkage, claim the lease, and update both Entries to running. A malformed aggregate is failed transactionally and returned as a rejected claim so the drain can continue without invoking a Runtime.

- [ ] **Step 4: Add lifecycle claim and lease-renew commands.**

`claimNextTurn` delegates to the repository transaction. `renewTurnLease` validates the same owner and remains a short local write. Neither method receives a Runtime callback.

- [ ] **Step 5: Use TX2 only for lifecycle-owned unbound IDs.**

Add a named predicate for `conversation:*` plus the legacy unbound identity. In `ConversationDispatcher`, route those IDs through `lifecycle.claimNextTurn`. Keep the project/workflow-bound claim/start code in an explicitly named legacy method. Remove the unbound Entry `running` writes from the driver.

- [ ] **Step 6: Run TX2 GREEN and the standard gate.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="ClaimNextTurn|TX2|conversation dispatch" ".tmp-tests/tests/conversation-lifecycle-repository.test.js" ".tmp-tests/tests/conversation-lifecycle-service.test.js" ".tmp-tests/tests/conversation-queue.test.js"
```

Expected: one claimant and one Runtime invocation per unbound Turn; bound queue tests remain unchanged.

- [ ] **Step 7: Commit TX2.**

```powershell
git add -- lib/conversation-lifecycle/types.ts lib/conversation-lifecycle/service.ts lib/hive-memory/repository.ts lib/conversation-dispatcher.ts tests/conversation-lifecycle-repository.test.ts tests/conversation-lifecycle-service.test.ts tests/conversation-queue.test.ts
git commit -m "Prevent execution before an atomic Turn claim" -m "Claim the unbound dispatch lease and move its Entry pair to running in one TX2 boundary, leaving deferred bound dispatch explicit." -m "Constraint: Runtime invocation starts only after TX2 commits
Confidence: high
Scope-risk: broad
Directive: A driver must never mark an unclaimed Turn running
Tested: claim races, lease recovery, malformed payloads, and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 7: Implement TX3 SettleTurn and post-commit behavior

**Files:**

- Modify: `repos/jormungand/lib/conversation-lifecycle/types.ts`
- Modify: `repos/jormungand/lib/conversation-lifecycle/service.ts`
- Modify: `repos/jormungand/lib/hive-memory/repository.ts`
- Modify: `repos/jormungand/lib/conversation-dispatcher.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-repository.test.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-service.test.ts`
- Modify: `repos/jormungand/tests/conversation-queue.test.ts`
- Modify: `repos/jormungand/tests/conversation-codex-dispatch.test.ts`

- [ ] **Step 1: Add failing settlement and rollback tests.**

Cover:

- completed outcome updates user + response Entries and completes the Job atomically;
- confirmed failed outcome fails both Entries and the Job;
- interrupted outcome marks both Entries interrupted and completes the Job with `{ status: "interrupted" }` because the existing Job enum has no interrupted value;
- unknown-delivery failure persists `deliveryState: "unknown"` in Job error/result context and does not requeue automatically;
- exact leading/trailing response whitespace is preserved;
- wrong/expired lease owner changes nothing;
- an injected response-update or Job-update failure rolls back the entire TX3;
- duplicate terminal outcome returns `applied: false` with unchanged records;
- a different late outcome after any terminal state is a no-op, not an overwrite.

- [ ] **Step 2: Run TX3 RED.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="SettleTurn|TX3|late outcome|delivery unknown|exact.*whitespace" ".tmp-tests/tests/conversation-lifecycle-repository.test.js" ".tmp-tests/tests/conversation-lifecycle-service.test.js" ".tmp-tests/tests/conversation-queue.test.js" ".tmp-tests/tests/conversation-codex-dispatch.test.js"
```

Expected: FAIL because the dispatcher still performs three independent writes.

- [ ] **Step 3: Implement the settlement transaction.**

Inside one `database.transaction`:

1. Load Job, parse the dispatch payload, and load both Entries.
2. Verify Conversation, IDs, reply linkage, running status, lease owner, and unexpired lease.
3. Ask the pure transition function whether to apply or no-op.
4. Update user Entry status, response Entry status/content, and Job terminal state.
5. Return a frozen settlement aggregate after commit.

Map outcomes as follows:

```ts
completed   -> Entries completed,   Job completed
interrupted -> Entries interrupted, Job completed with result.status = "interrupted"
failed      -> Entries failed,      Job failed
```

- [ ] **Step 4: Make the dispatcher a driver, not a writer.**

For lifecycle-owned unbound IDs, the dispatcher flow must be:

```ts
const envelope = await lifecycle.claimNextTurn({
  conversationId,
  leaseOwner: `conversation:${conversationId}:${process.pid}`,
  leaseDurationMs: 5 * 60 * 1000
})
if (!envelope) return

const outcome = await invokeRuntime(envelope) // no DB transaction is open
const settled = await lifecycle.settleTurn({
  jobId: envelope.jobId,
  leaseOwner: envelope.leaseOwner,
  outcome
})
await publishAfterCommit(settled.notification).catch(reportPublicationFailure)
```

Clear the lease-renew timer before settlement. If Runtime invocation throws, convert it to a failed `ProviderOutcome` and still use TX3. If the post-commit publisher throws, return/retain the durable settlement and let GET/polling rehydrate it.

- [ ] **Step 5: Prove no transaction spans the Runtime call.**

Use a deferred Runtime promise. While it is pending, perform a repository read and a settings write on the same database and assert both complete. Then resolve the Runtime and assert TX3 settlement. This test must fail if a SQLite transaction is held across the deferred promise.

- [ ] **Step 6: Run TX3 GREEN and the standard gate.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="SettleTurn|TX3|post-commit|transaction spans|dispatcher" ".tmp-tests/tests/conversation-lifecycle-repository.test.js" ".tmp-tests/tests/conversation-lifecycle-service.test.js" ".tmp-tests/tests/conversation-queue.test.js" ".tmp-tests/tests/conversation-codex-dispatch.test.js"
```

- [ ] **Step 7: Commit TX3.**

```powershell
git add -- lib/conversation-lifecycle/types.ts lib/conversation-lifecycle/service.ts lib/hive-memory/repository.ts lib/conversation-dispatcher.ts tests/conversation-lifecycle-repository.test.ts tests/conversation-lifecycle-service.test.ts tests/conversation-queue.test.ts tests/conversation-codex-dispatch.test.ts
git commit -m "Keep durable Turn truth consistent after Runtime outcomes" -m "Settle the Entry pair and dispatch Job in TX3, ignore duplicate or late terminal outcomes, and isolate live publication from durable commit success." -m "Constraint: No database transaction spans a Runtime call
Confidence: high
Scope-risk: broad
Directive: Provider failures and thrown exceptions must settle through the same TX3 path
Tested: settlement rollback, lease ownership, terminal-once, publication failure, and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 8: Make Stop atomic while preserving Pause and Continue

**Files:**

- Modify: `repos/jormungand/lib/conversation-lifecycle/service.ts`
- Modify: `repos/jormungand/lib/hive-memory/repository.ts`
- Modify: `repos/jormungand/lib/codex-conversation.ts`
- Modify: `repos/jormungand/app/api/conversation/control/route.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-repository.test.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-service.test.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-structure.test.ts`
- Modify: `repos/jormungand/tests/codex-native-conversation-sync.test.ts`
- Modify: `repos/jormungand/tests/conversation-ui-behavior.test.ts`

- [ ] **Step 1: Add RED stop/cancel/pause/resume race tests.**

Assert:

- canceling pending Turns marks each queued Entry pair and Job canceled in one transaction;
- stopping a running Turn marks Entries interrupted and Job canceled/terminal in one transaction;
- late completed/failed outcomes after Stop are no-ops;
- `interrupt`/Pause updates Codex provider telemetry but keeps the application Turn running;
- `resume`/Continue can complete that same application Turn;
- `stop` keeps the existing route response shape and prevents later completion;
- a second Stop is idempotent.

- [ ] **Step 2: Run the focused RED tests.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="cancel pending|StopTurn|Pause|Continue|late.*Stop" ".tmp-tests/tests/conversation-lifecycle-repository.test.js" ".tmp-tests/tests/conversation-lifecycle-service.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/codex-native-conversation-sync.test.js" ".tmp-tests/tests/conversation-ui-behavior.test.js"
```

Expected: FAIL because queued Jobs and Entries are canceled separately and paused provider state can currently become an interrupted terminal Entry.

- [ ] **Step 3: Implement `cancelPendingTurns` and `stopTurn`.**

Both are short SQLite transactions. `cancelPendingTurns` updates every queued conversation Job and its pair. `stopTurn` validates the current running aggregate and atomically terminalizes it. Neither command calls a bridge.

- [ ] **Step 4: Preserve the current control-route side-effect order.**

Keep current behavior for pending messages: cancel pending first. Then:

- `interrupt`: call the Codex control adapter; do not terminalize the running Turn.
- `resume`: call the Codex control adapter; do not reopen or mutate terminal truth.
- `stop`: call the Codex control adapter and, after confirmed success, call `lifecycle.stopTurn` for the active Turn.

If the remote control call fails, retain the characterized error/status. Document that pending cancellation may already be durable, matching current order.

- [ ] **Step 5: Treat paused native state as progress.**

In Codex synchronization, map `status = "paused"` / `turnStatus = "interrupted"` to a progress observation with pause copy, not a terminal Turn transition. A later resumed native turn may update progress and eventually settle completed. Map explicit stopped session state to an interrupted terminal outcome.

- [ ] **Step 6: Run focused GREEN and the standard gate.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="cancel pending|StopTurn|Pause|Continue|late.*Stop" ".tmp-tests/tests/conversation-lifecycle-repository.test.js" ".tmp-tests/tests/conversation-lifecycle-service.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/codex-native-conversation-sync.test.js" ".tmp-tests/tests/conversation-ui-behavior.test.js"
```

- [ ] **Step 7: Commit control semantics.**

```powershell
git add -- lib/conversation-lifecycle/service.ts lib/hive-memory/repository.ts lib/codex-conversation.ts app/api/conversation/control/route.ts tests/conversation-lifecycle-repository.test.ts tests/conversation-lifecycle-service.test.ts tests/conversation-lifecycle-structure.test.ts tests/codex-native-conversation-sync.test.ts tests/conversation-ui-behavior.test.ts
git commit -m "Preserve Continue without weakening terminal Turn truth" -m "Keep Pause as provider telemetry, make pending cancellation and Stop atomic, and reject every outcome that arrives after Stop." -m "Constraint: Existing control route fields and status codes remain unchanged
Confidence: medium
Scope-risk: broad
Directive: Do not map provider paused state directly to terminal Turn state
Tested: pause-resume-stop races and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 9: Move Codex progress and native reconciliation behind the module

**Files:**

- Modify: `repos/jormungand/lib/conversation-lifecycle/types.ts`
- Modify: `repos/jormungand/lib/conversation-lifecycle/service.ts`
- Modify: `repos/jormungand/lib/hive-memory/repository.ts`
- Modify: `repos/jormungand/lib/codex-conversation.ts`
- Modify: `repos/jormungand/lib/codex-sync-worker.ts`
- Modify: `repos/jormungand/lib/hive-services.ts`
- Modify: `repos/jormungand/app/api/conversation/route.ts`
- Modify: `repos/jormungand/tests/codex-native-conversation-sync.test.ts`
- Modify: `repos/jormungand/tests/codex-shared-history.test.ts`
- Modify: `repos/jormungand/tests/codex-conversation-structure.test.ts`

- [ ] **Step 1: Add RED lifecycle-port tests for Codex sync.**

Use a lifecycle spy and assert:

- running/live text calls `recordTurnProgress` and never `repository.updateConversation` from the adapter;
- completed/failed/stopped provider states call `settleTurn` with normalized outcomes;
- offline/replacement-pending updates only Codex telemetry and never changes Turn status;
- native-only user/agent items call `reconcileProviderEntry` and then record their Codex ledger item;
- repeated projection reuses the idempotent Entry;
- coalescing duplicate native/Harness responses calls `coalesceProviderEntries` through the module.

- [ ] **Step 2: Run Codex sync RED.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="lifecycle port|native.*reconciliation|offline.*Turn|coalesc" ".tmp-tests/tests/codex-native-conversation-sync.test.js" ".tmp-tests/tests/codex-shared-history.test.js" ".tmp-tests/tests/codex-conversation-structure.test.js"
```

Expected: FAIL because `syncConversation` and `syncNativeThread` still call Entry write methods directly.

- [ ] **Step 3: Define a narrow runtime-neutral reconciliation port.**

Codex code depends on an interface, not the concrete service:

```ts
export interface ConversationLifecyclePort {
  recordTurnProgress(input: RecordTurnProgressInput): Promise<TurnSnapshot>
  settleTurn(input: SettleTurnInput): Promise<SettledTurn>
  reconcileProviderEntry(input: ReconcileProviderEntryInput): Promise<ConversationEntry>
  coalesceProviderEntries(input: { preferredId: string; duplicateId: string }): Promise<void>
}
```

`reconcileProviderEntry` is the only no-Job exception: it imports a provider-originated Turn that did not enter through Jormungand. It must be idempotent, scoped to an active unbound Conversation, and documented in the feature matrix. Do not fabricate an Execution Job for native-only history.

- [ ] **Step 4: Separate core reconciliation from telemetry.**

Keep `updateCodexSession`, cursor, mapping state, native name, and sync ledger as provider telemetry. Route all Conversation Entry content/status/merge writes through the lifecycle port. Record the ledger after core commit; if ledger persistence fails, retry reuses the Entry idempotency key and records the ledger without duplication.

- [ ] **Step 5: Inject lifecycle into GET and the background worker.**

Change `getCodexConversationState` and the sync worker wiring to receive the lifecycle port. Every production call in `hive-services.ts` and `app/api/conversation/route.ts` must pass the one service instance.

- [ ] **Step 6: Remove obsolete direct Codex migration helpers.**

Run:

```powershell
rg -n "postCodexConversationMessage|dispatchCodexConversationEntry" app lib
```

If only definitions/comments remain, delete `postCodexConversationMessage` and the unused direct dispatch helper. Move shared-history and polling tests to lifecycle submit/dispatcher or a pure Codex adapter fixture. Remove the stale route comment/assertion that treats the helper as active behavior.

- [ ] **Step 7: Run Codex sync GREEN and the standard gate.**

```powershell
npx tsc -p tsconfig.tests.json
node --test ".tmp-tests/tests/codex-native-conversation-sync.test.js" ".tmp-tests/tests/codex-shared-history.test.js" ".tmp-tests/tests/codex-conversation-structure.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js"
```

- [ ] **Step 8: Commit the Codex slice.**

```powershell
git add -- lib/conversation-lifecycle/types.ts lib/conversation-lifecycle/service.ts lib/hive-memory/repository.ts lib/codex-conversation.ts lib/codex-sync-worker.ts lib/hive-services.ts app/api/conversation/route.ts tests/codex-native-conversation-sync.test.ts tests/codex-shared-history.test.ts tests/codex-conversation-structure.test.ts tests/conversation-lifecycle-structure.test.ts
git commit -m "Stop Codex synchronization from competing with lifecycle truth" -m "Keep Codex mapping telemetry provider-specific while routing progress, settlement, native imports, and coalescing through the sole writer." -m "Constraint: Provider-originated native history has no fabricated Execution Job
Confidence: medium
Scope-risk: broad
Directive: Codex telemetry must never write core Entry status directly
Tested: native sync, restart, coalescing, shared history, and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 10: Normalize Lucky Runtime outcomes at the lifecycle boundary

**Files:**

- Modify: `repos/jormungand/lib/hive-services.ts`
- Modify: `repos/jormungand/lib/conversation-lifecycle/types.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-characterization.test.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-structure.test.ts`
- Modify: `repos/jormungand/tests/conversation-queue.test.ts`

- [ ] **Step 1: Add a RED Lucky Runtime outcome-contract test.**

Submit and drain a Mavis Turn through the production service wiring with a fake `invokeAgent`. Assert the lifecycle boundary receives:

```ts
{
  kind: "completed",
  body: "runtime response",
  deliveryState: "confirmed"
}
```

Add confirmed failure and unknown-delivery cases. Assert the selected Agent Profile remains `mavis`, the existing Codex Device Ingress request shape is unchanged, and no Codex native sync method is called.

- [ ] **Step 2: Run the RED contract.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="Lucky Runtime outcome" ".tmp-tests/tests/conversation-lifecycle-characterization.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/conversation-queue.test.js"
```

Expected: FAIL until the current agent artifact result is explicitly normalized to `ProviderOutcome`.

- [ ] **Step 3: Add one result normalizer without changing transport.**

Map the existing `AgentArtifactResult` to `ProviderOutcome` after the Runtime call and before `settleTurn`. Preserve exact body text and delivery certainty. Do not move, rename, or redesign bridge selection, quota behavior, session behavior, Agent Profile metadata, or Codex Device Ingress.

- [ ] **Step 4: Run focused GREEN and the standard gate.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="Lucky Runtime outcome" ".tmp-tests/tests/conversation-lifecycle-characterization.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/conversation-queue.test.js"
```

- [ ] **Step 5: Commit the Lucky Runtime slice.**

```powershell
git add -- lib/hive-services.ts lib/conversation-lifecycle/types.ts tests/conversation-lifecycle-characterization.test.ts tests/conversation-lifecycle-structure.test.ts tests/conversation-queue.test.ts
git commit -m "Make Lucky Runtime outcomes obey the same durable settlement rules" -m "Normalize Mavis execution results only at the lifecycle boundary while preserving the accepted ingress and Runtime behavior." -m "Constraint: Runtime-private implementation details remain outside architecture and domain language
Confidence: high
Scope-risk: narrow
Tested: Lucky Runtime outcome contracts and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 11: Normalize OpenClaw outcomes without weakening delivery recovery

**Files:**

- Modify: `repos/jormungand/lib/hive-services.ts`
- Modify: `repos/jormungand/lib/conversation-lifecycle/types.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-structure.test.ts`
- Modify: `repos/jormungand/tests/conversation-queue.test.ts`
- Modify: `repos/jormungand/tests/agent-bridge-live.test.ts`

- [ ] **Step 1: Add RED OpenClaw outcome-contract tests.**

Assert:

- confirmed completion maps to completed TX3 settlement;
- confirmed Runtime failure maps to failed TX3 settlement;
- ambiguous delivery maps to failed outcome with `deliveryState: "unknown"` and never auto-requeues;
- duplicate submission after ambiguous delivery returns the same terminal identities and does not invoke OpenClaw again;
- persistent session bootstrap/cursor behavior remains exactly as current tests specify;
- live terminal publication still occurs outside TX3.

- [ ] **Step 2: Run the RED contracts.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="OpenClaw outcome|ambiguous delivery|delivery unknown" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/conversation-queue.test.js" ".tmp-tests/tests/agent-bridge-live.test.js"
```

Expected: FAIL until delivery certainty is carried into `ProviderOutcome`/TX3.

- [ ] **Step 3: Normalize after the existing session/recovery adapter.**

Keep `routeDirectOpenClawConversation`, `deriveOpenClawSessionIdentity`, bootstrap state, `lastDeliveredEntryId`, and bridge recovery unchanged. Convert its final result to the lifecycle outcome only after those decisions. An unknown delivery is terminal for that idempotency key and requires explicit operator action/new Turn; it is never blindly re-delivered.

- [ ] **Step 4: Run focused GREEN and the standard gate.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="OpenClaw outcome|ambiguous delivery|delivery unknown" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/conversation-queue.test.js" ".tmp-tests/tests/agent-bridge-live.test.js"
```

- [ ] **Step 5: Commit the OpenClaw slice.**

```powershell
git add -- lib/hive-services.ts lib/conversation-lifecycle/types.ts tests/conversation-lifecycle-structure.test.ts tests/conversation-queue.test.ts tests/agent-bridge-live.test.ts
git commit -m "Keep ambiguous OpenClaw delivery from becoming a duplicate execution" -m "Carry confirmed versus unknown delivery into lifecycle settlement without altering persistent sessions, bootstrap, or recovery transport behavior." -m "Constraint: Unknown delivery is never auto-requeued
Confidence: high
Scope-risk: moderate
Tested: OpenClaw delivery, recovery, session, live-event, and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 12: Move settings and management writes behind lifecycle commands

**Files:**

- Modify: `repos/jormungand/lib/conversation-lifecycle/service.ts`
- Modify: `repos/jormungand/lib/conversation-management.ts`
- Modify: `repos/jormungand/lib/hive-services.ts`
- Modify: `repos/jormungand/app/api/conversations/route.ts`
- Modify: `repos/jormungand/app/api/conversations/[id]/route.ts`
- Modify: `repos/jormungand/tests/conversation-management.test.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-structure.test.ts`
- Modify: `repos/jormungand/tests/conversation-ui-behavior.test.ts`

- [ ] **Step 1: Add RED lifecycle-spy management tests.**

Assert the management service performs no direct core repository write for create, settings, rename, archive, unarchive, or delete. Preserve these orders:

```text
rename/archive/unarchive: validate -> native side effect -> lifecycle local commit
delete: validate -> cancel pending -> native delete -> stop session -> lifecycle local delete
settings: validate -> lifecycle local commit (no native side effect)
```

Retain the known-gap tests: native success plus local failure is surfaced and documented; retry is idempotent where the existing native operation permits it.

- [ ] **Step 2: Run management RED.**

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="management.*lifecycle|native.*local|rename|archive|delete|model selection" ".tmp-tests/tests/conversation-management.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/conversation-ui-behavior.test.js"
```

Expected: FAIL because `ConversationManagementService` still calls core write methods on the repository.

- [ ] **Step 3: Add management commands to the lifecycle service.**

Implement `createConversation`, `updateConversationSettings`, `renameConversation`, `setConversationState`, and `deleteConversation`. Keep validation that is domain-invariant in lifecycle; keep HTTP parsing and native bridge calls in drivers. `deleteConversation` retains the current one-transaction local cleanup of Job, OpenClaw session telemetry, Codex telemetry/ledger, Entries, and metadata.

- [ ] **Step 4: Replace management writes but preserve read models.**

`ConversationManagementService` may continue repository reads for list/summary/session presence. Replace only writes with lifecycle commands. Keep all route JSON, status, cookie, confirmation, and UI behavior tests unchanged.

- [ ] **Step 5: Run management GREEN and the standard gate.**

```powershell
npx tsc -p tsconfig.tests.json
node --test ".tmp-tests/tests/conversation-management.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/conversation-ui-behavior.test.js"
```

- [ ] **Step 6: Commit management ownership.**

```powershell
git add -- lib/conversation-lifecycle/service.ts lib/conversation-management.ts lib/hive-services.ts app/api/conversations/route.ts app/api/conversations/[id]/route.ts tests/conversation-management.test.ts tests/conversation-lifecycle-structure.test.ts tests/conversation-ui-behavior.test.ts
git commit -m "Keep conversation management from bypassing lifecycle policy" -m "Preserve native side-effect order and HTTP behavior while moving every local unbound management write behind the sole writer." -m "Constraint: Native side effects and SQLite still have a documented crash gap
Confidence: high
Scope-risk: moderate
Directive: Do not claim cross-system exactly-once without an approved outbox migration
Tested: management ordering, failures, route contracts, UI contracts, and standard green gate
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Task 13: Enforce ownership, delete obsolete paths, and close the matrix

**Files:**

- Create: `repos/jormungand/tests/conversation-lifecycle-ownership.test.ts`
- Modify: `repos/jormungand/lib/conversation-dispatcher.ts`
- Modify: `repos/jormungand/lib/conversation.ts`
- Modify: `repos/jormungand/lib/hive-services.ts`
- Modify: `repos/jormungand/docs/superpowers/evidence/2026-09-02-conversation-lifecycle-feature-matrix.md`
- Modify: `repos/jormungand/tests/codex-conversation-structure.test.ts`
- Modify: `repos/jormungand/tests/conversation.test.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-structure.test.ts`
- Modify: `repos/jormungand/tests/conversation-queue.test.ts`

- [ ] **Step 1: Add a RED TypeScript-AST ownership test.**

Use the installed `typescript` package to create a `Program` from `tsconfig.json` and obtain its `TypeChecker`. Inspect production `.ts`/`.tsx` call expressions, resolve the property symbol, and guard the call only when the resolved method declaration belongs to `lib/hive-memory/repository.ts`. This avoids false positives such as `ConversationManagementService.createConversation()`. Guard these repository methods:

```ts
const guardedWrites = new Set([
  "insertConversation",
  "updateConversation",
  "createConversationDispatch",
  "claimNextConversationDispatch",
  "cancelQueuedConversationDispatches",
  "completeExecutionJob",
  "failExecutionJob",
  "submitConversationTurn",
  "claimNextConversationTurn",
  "settleConversationTurn",
  "cancelPendingConversationTurns",
  "stopConversationTurn",
  "moveConversation",
  "createConversation",
  "updateConversationProfile",
  "renameConversation",
  "setConversationState",
  "deleteConversation",
  "mergeConversationEntries"
])
```

Resolve the declaration before recording a match:

```ts
const symbol = checker.getSymbolAtLocation(call.expression.name)
const declarationFile = symbol?.declarations?.[0]?.getSourceFile().fileName
if (!declarationFile?.replaceAll("\\", "/").endsWith("lib/hive-memory/repository.ts")) return
```

Exclude `lib/hive-memory/repository.ts` and files under `lib/conversation-lifecycle/`. Every other repository-method match must belong to an exact `{ file, containingFunction, method }` tuple in `legacyBoundWriterAllowlist`. Generic execution-job infrastructure whose receiver type does not resolve to `HiveMemoryRepository` is outside this core-writer gate.

- [ ] **Step 2: Seed only verified workflow-bound exceptions.**

Expected surviving categories are:

- bound `ConversationService.postMessage`/bound queue behavior;
- the explicitly named legacy bound branch in `ConversationDispatcher`;
- Hive worker handoff persistence in `createHiveServices`.

Do not allow a whole directory or wildcard. Split mixed unbound/bound functions before allowlisting. Add a test assertion that the allowlist has the exact expected length so it cannot grow silently.

- [ ] **Step 3: Run ownership RED and inspect every match.**

```powershell
npx tsc -p tsconfig.tests.json
node --test ".tmp-tests/tests/conversation-lifecycle-ownership.test.js"
```

Expected: FAIL with a concrete list of remaining direct production writers. Classify each as migrated unbound (must remove) or verified bound legacy (may enter the exact allowlist).

- [ ] **Step 4: Delete obsolete unbound bypasses.**

Use `rg` to prove no production caller before deletion. Remove unused synchronous unbound queue/Codex helper paths, duplicate payload parsers, and direct write branches superseded by lifecycle commands. Do not delete repository primitives still required by the explicit bound allowlist or tests.

- [ ] **Step 5: Run ownership GREEN and all affected contracts.**

```powershell
npx tsc -p tsconfig.tests.json
node --test ".tmp-tests/tests/conversation-lifecycle-ownership.test.js" ".tmp-tests/tests/conversation-lifecycle-repository.test.js" ".tmp-tests/tests/conversation-lifecycle-service.test.js" ".tmp-tests/tests/conversation-queue.test.js" ".tmp-tests/tests/conversation-lifecycle-structure.test.js" ".tmp-tests/tests/codex-native-conversation-sync.test.js" ".tmp-tests/tests/conversation-management.test.js"
```

Expected: all pass; any new direct unbound writer makes the ownership test fail with file, containing function, and method.

- [ ] **Step 6: Complete the feature matrix.**

For every row, replace target-evidence references with passing test names and record:

- final owning command;
- TX boundary or no-transaction reason;
- Runtime path;
- live/rehydration evidence;
- remaining workflow-bound exception;
- native-management crash-gap statement.

Add a “schema verification” note linking `tests/hive-memory-database.test.ts` and the unchanged `hiveSchemaVersion = 10` assertion.

- [ ] **Step 7: Run the final standard gate twice where races matter.**

```powershell
npm test
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
git status --short
```

Expected: both test runs pass; typecheck passes; lint has 0 errors and no new warnings; build passes; only intended tracked files are modified/staged. Generated `.harness/superpowers-catalog/` and `data/` remain unstaged.

- [ ] **Step 8: Inspect schema and UI scope before commit.**

```powershell
git diff --name-only HEAD -- lib/hive-memory/schema.ts components/task-conversation.tsx app/globals.css
git diff HEAD -- lib/hive-memory/schema.ts components/task-conversation.tsx app/globals.css
```

Expected: no diff in schema, TaskConversation, or global CSS. If any appears, remove it or split it into a separately approved change.

- [ ] **Step 9: Commit enforcement and evidence.**

```powershell
git add -- docs/superpowers/evidence/2026-09-02-conversation-lifecycle-feature-matrix.md lib/conversation-dispatcher.ts lib/conversation.ts lib/hive-services.ts tests/conversation-lifecycle-ownership.test.ts tests/codex-conversation-structure.test.ts tests/conversation.test.ts tests/conversation-lifecycle-structure.test.ts tests/conversation-queue.test.ts
git diff --cached --name-only
git commit -m "Keep unbound lifecycle ownership from drifting again" -m "Enforce the sole-writer boundary with an exact shrinking bound-workflow allowlist, remove obsolete bypasses, and close every feature-matrix row with executable evidence." -m "Constraint: Workflow-bound migration remains deferred and auditable
Confidence: high
Scope-risk: moderate
Directive: The legacy writer allowlist may shrink but must never grow without a new approved architecture decision
Tested: repeated full suite, typecheck, lint, build, ownership gate, and schema/UI scope audit
Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

## Final verification checklist

- [ ] Every feature-matrix row links to a passing current and target test.
- [ ] TX1 rollback leaves no partial user Entry, response Entry, or Job.
- [ ] TX2 permits one lease owner and one Runtime call.
- [ ] TX3 keeps Entry pair and Job consistent on success, failure, interruption, duplicate, late outcome, and injected SQLite failure.
- [ ] Pause remains nonterminal provider telemetry; Continue can finish the same application Turn; Stop is terminal-once.
- [ ] Codex telemetry cannot directly mutate core lifecycle state.
- [ ] Lucky Runtime and OpenClaw preserve current ingress/session behavior and return normalized outcomes.
- [ ] Native-only Codex history uses the explicit reconciliation command and no fabricated Job.
- [ ] No transaction spans a Runtime/network wait.
- [ ] HTTP status codes and JSON shapes match Phase 0 characterization.
- [ ] UI structure, labels, polling, SSE, schema version, and persisted-row compatibility are unchanged.
- [ ] Native-management crash gap is tested and documented, not described as solved.
- [ ] Ownership allowlist contains exact workflow-bound exceptions only and has not grown.
- [ ] Two full test runs, typecheck, lint, build, and `git diff --check` pass.

## Rollback boundaries

Each task is independently revertible in reverse order. If a Runtime-specific slice fails, revert only that slice and keep TX1/TX2/TX3 plus earlier migrated paths green. Do not restore an unbound direct writer as a hotfix; route the affected driver back through the last passing lifecycle command. If TX1/TX2/TX3 itself fails compatibility verification, revert the corresponding task commit and leave the Phase 0 matrix/characterization commit in place as durable evidence.
