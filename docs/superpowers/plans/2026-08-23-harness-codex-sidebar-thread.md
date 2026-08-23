# Harness ↔ Codex Native Thread Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one native Codex App Server thread per Harness conversation and synchronize native Codex messages, replies, statuses, lifecycle, and durable queued work in both directions.

**Architecture:** Keep the native Codex thread as the authoritative Codex transcript. Extend Harness SQLite with durable thread mapping, lineage, FIFO job metadata, and a native-item sync ledger. Extend the authenticated device Bridge with start/resume/read/name/archive/delete operations over the official App Server protocol, while the Harness service owns recovery, projection, and the 30-second sync worker.

**Tech Stack:** Next.js 16, TypeScript, Node `node:test`, better-sqlite3, Codex App Server JSON-RPC over stdio, Zeabur dev deployment, in-app browser verification.

---

## Scope map

| Unit | Responsibility | Files |
|---|---|---|
| Native Bridge lifecycle | Start/resume/read/name/archive/delete native threads and expose full permission policy | `repos/jormungand/scripts/codex-bridge.mjs` |
| Durable state | Store mapping, replacement lineage, sync cursor, and native item deduplication | `repos/jormungand/lib/hive-memory/schema.ts`, `repository.ts`, `types.ts` |
| Projection | Convert native thread turns/items into Harness entries without replaying synthetic context | `repos/jormungand/lib/codex-thread-sync.ts`, `codex-conversation.ts` |
| Background worker | Poll native snapshots, retry offline work, and serialize sync | `repos/jormungand/lib/codex-sync-worker.ts`, `hive-services.ts` |
| User surface | Show native thread/sync/replacement status without focusing Codex | `repos/jormungand/components/task-conversation.tsx`, existing API state types |
| Verification | Unit, integration, local E2E, dev deployment/browser evidence | `repos/jormungand/tests/*`, deployment environment |

## Task 1: Add testable native Bridge thread lifecycle

**Files:**
- Create: `repos/jormungand/scripts/codex-app-server-session.mjs`
- Modify: `repos/jormungand/scripts/codex-bridge.mjs`
- Create: `repos/jormungand/tests/codex-app-server-session.test.ts`
- Modify: `repos/jormungand/tests/codex-conversation-structure.test.ts`

- [ ] **Step 1: Write the failing protocol tests**

Create a small exported session adapter around the existing JSON-RPC transport. The tests must assert the exact requests emitted by these calls:

```ts
test("resumes a persisted thread instead of starting a replacement", async () => {
  const transport = createRecordingTransport([
    { id: 1, result: { thread: { id: "thread-existing" } } }
  ])
  const session = createCodexAppServerSession({
    transport,
    workspacePath: "C:/workspace",
    permissionMode: "full",
    threadId: "thread-existing",
    name: "Harness · Existing"
  })

  await session.start()

  assert.equal(transport.requests[1].method, "thread/resume")
  assert.equal(transport.requests[1].params.threadId, "thread-existing")
  assert.equal(transport.requests.some((request) => request.method === "thread/start"), false)
})

test("full mode applies danger full access without administrator elevation", async () => {
  const transport = createRecordingTransport([
    { id: 1, result: { thread: { id: "thread-new" } } }
  ])
  const session = createCodexAppServerSession({
    transport,
    workspacePath: "C:/workspace",
    permissionMode: "full",
    name: "Harness · New"
  })

  await session.start()

  assert.equal(transport.requests[1].method, "thread/start")
  assert.equal(transport.requests[1].params.sandbox, "danger-full-access")
  assert.equal(transport.requests[1].params.approvalPolicy, "never")
})
```

Also cover `thread/read` with `includeTurns: true`, `thread/name/set`, archive, delete, and the explicit HTTP error returned when a requested thread is unrecoverable.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run from `repos/jormungand`:

```powershell
npm test -- --test-name-pattern="native thread|danger full access|thread name"
```

Expected: fail because the extracted session adapter and lifecycle operations do not exist.

- [ ] **Step 3: Implement the minimal session adapter**

Move only the reusable JSON-RPC request/response and permission-policy logic out of the monolithic bridge. The adapter must expose:

```js
start()
readThread()
startTurn(input)
resume()
rename(name)
archive()
delete()
interrupt(turnId)
stop()
```

`start()` must call `thread/resume` when a stored thread id is supplied and `thread/start` otherwise. It must return the native `threadId`, `status`, and current turn information. Do not add an administrator/elevation flag.

- [ ] **Step 4: Add Bridge HTTP lifecycle endpoints**

Extend `POST /sessions` to accept an optional `threadId` and user-facing `name`. Add:

```text
GET  /sessions/:id/thread
POST /sessions/:id/name
POST /sessions/:id/archive
POST /sessions/:id/delete
```

`GET /sessions/:id/thread` must return a normalized native thread snapshot with `threadId`, `turns`, `status`, `name`, and `archived`. Return 404 for a missing native thread so Harness can enter replacement-pending state. Keep bearer authentication and repository-origin checks unchanged.

- [ ] **Step 5: Run focused tests and update structural assertions**

Run:

```powershell
npm test -- --test-name-pattern="native thread|Codex bridge"
```

Expected: all lifecycle and existing permission tests pass.

- [ ] **Step 6: Commit the Bridge unit**

```powershell
git add scripts/codex-app-server-session.mjs scripts/codex-bridge.mjs tests/codex-app-server-session.test.ts tests/codex-conversation-structure.test.ts
git commit -m "feat: add resumable Codex native thread lifecycle"
```

## Task 2: Add durable mapping and native-item sync ledger

**Files:**
- Modify: `repos/jormungand/lib/hive-memory/schema.ts`
- Modify: `repos/jormungand/lib/hive-memory/types.ts`
- Modify: `repos/jormungand/lib/hive-memory/repository.ts`
- Modify: `repos/jormungand/tests/hive-memory-database.test.ts`
- Modify: `repos/jormungand/tests/hive-memory-repository.test.ts`
- Create: `repos/jormungand/tests/codex-sync-ledger.test.ts`

- [ ] **Step 1: Write failing schema/repository tests**

Add tests for schema version 7, durable mapping state, replacement lineage, and idempotent native-item recording:

```ts
test("records one native item once by thread, turn, and item identity", async (t) => {
  const repository = await repositoryFixture(t)
  const first = await repository.recordCodexSyncItem({
    conversationId: "conversation:sync",
    nativeThreadId: "thread-1",
    nativeTurnId: "turn-1",
    nativeItemId: "item-1",
    source: "codex",
    kind: "agentMessage",
    contentHash: "hash-1"
  })
  const duplicate = await repository.recordCodexSyncItem({
    conversationId: "conversation:sync",
    nativeThreadId: "thread-1",
    nativeTurnId: "turn-1",
    nativeItemId: "item-1",
    source: "codex",
    kind: "agentMessage",
    contentHash: "hash-1"
  })

  assert.equal(first.inserted, true)
  assert.equal(duplicate.inserted, false)
  assert.equal(repository.listCodexSyncItems("conversation:sync").length, 1)
})
```

Add a restart test proving the stored native thread id survives closing and reopening the database.

- [ ] **Step 2: Run the tests and confirm RED**

```powershell
npm test -- --test-name-pattern="schema version 7|native item|replacement lineage"
```

Expected: fail because migration V7 and repository methods are absent.

- [ ] **Step 3: Add migration V7**

Keep existing migrations intact and append a migration that:

```sql
ALTER TABLE codex_sessions ADD COLUMN mapping_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE codex_sessions ADD COLUMN replacement_of_thread_id TEXT;
ALTER TABLE codex_sessions ADD COLUMN native_name TEXT;
ALTER TABLE codex_sessions ADD COLUMN native_cursor TEXT;
CREATE TABLE codex_sync_ledger (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  native_thread_id TEXT NOT NULL,
  native_turn_id TEXT NOT NULL,
  native_item_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  conversation_entry_id TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(native_thread_id, native_turn_id, native_item_id)
);
CREATE UNIQUE INDEX codex_sync_identity_idx
  ON codex_sync_ledger(native_thread_id, native_turn_id, native_item_id);
```

Use the repository's existing schema migration runner and set `hiveSchemaVersion` to 7. The ledger must store `conversation_id`, native thread/turn/item ids, source, kind, optional Harness entry id, content hash, and timestamps.

- [ ] **Step 4: Add typed repository operations**

Add typed methods for:

- Updating mapping state/name/replacement lineage/native cursor without resetting the durable thread id.
- Listing active Codex mappings for the sync worker.
- Recording a native item with `INSERT OR IGNORE` semantics.
- Finding an existing ledger row by native identity.
- Listing pending outbound jobs for one conversation.

Do not change existing `conversation_entries` idempotency behavior.

- [ ] **Step 5: Run focused persistence tests**

```powershell
npm test -- --test-name-pattern="database initializes|native item|Codex session"
```

Expected: schema, restart, repository, and idempotency tests pass.

- [ ] **Step 6: Commit the persistence unit**

```powershell
git add lib/hive-memory/schema.ts lib/hive-memory/types.ts lib/hive-memory/repository.ts tests/hive-memory-database.test.ts tests/hive-memory-repository.test.ts tests/codex-sync-ledger.test.ts
git commit -m "feat: persist Codex thread synchronization ledger"
```

## Task 3: Normalize native turns and project them into Harness

**Files:**
- Create: `repos/jormungand/lib/codex-thread-sync.ts`
- Modify: `repos/jormungand/lib/codex-conversation.ts`
- Create: `repos/jormungand/tests/codex-thread-sync.test.ts`
- Modify: `repos/jormungand/tests/conversation-codex-dispatch.test.ts`
- Modify: `repos/jormungand/tests/codex-shared-history.test.ts`

- [ ] **Step 1: Write failing projection tests**

Test these separate behaviors:

```ts
test("does not import Harness-originated synthetic context as a second user entry", () => {
  const result = projectNativeThread({
    conversationId: "conversation:projection",
    nativeThreadId: "thread-1",
    turns: [harnessOriginatedTurn, codexReplyTurn]
  })

  assert.deepEqual(result.entries.map((entry) => entry.content), ["Codex reply"])
})

test("imports an unknown Codex desktop turn with stable native idempotency", () => {
  const result = projectNativeThread({
    conversationId: "conversation:projection",
    nativeThreadId: "thread-1",
    turns: [codexDesktopUserTurn, codexReplyTurn]
  })

  assert.equal(result.entries[0].idempotencyKey, "codex:thread-1:turn-2:item-user")
  assert.equal(result.entries[1].replyToNativeTurnId, "turn-2")
})
```

Also test native ordering, command/status projection, partial-to-completed response convergence, and a snapshot that repeats already-ledgered items.

- [ ] **Step 2: Run the tests and confirm RED**

```powershell
npm test -- --test-name-pattern="synthetic context|unknown Codex desktop turn|native ordering"
```

Expected: fail because native turn normalization/projection does not exist.

- [ ] **Step 3: Implement the pure normalizer/projector**

Create a pure module that accepts normalized native thread snapshots and returns:

```ts
type NativeThreadProjection = {
  entries: Array<{
    nativeThreadId: string
    nativeTurnId: string
    nativeItemId: string
    role: "user" | "agent"
    content: string
    status: "running" | "completed" | "failed" | "interrupted"
    source: "harness" | "codex"
    replyToNativeTurnId?: string
  }>
  terminalStatus?: "completed" | "failed" | "interrupted"
}
```

The projector must classify a native turn as Harness-originated using the durable outbound ledger, not by string-matching the prompt. It must preserve native order and ignore ledgered identities.

- [ ] **Step 4: Integrate projection into Codex conversation state**

Update `getCodexConversationState` and the dispatch path to:

1. Resume the stored native thread through the Bridge.
2. Read the native snapshot after event reads or when the cursor is stale.
3. Apply the pure projection through repository transactions.
4. Update existing response entries instead of inserting duplicates.
5. Persist the native cursor and mapping status.

Do not remove the existing live event behavior until snapshot recovery is green.

- [ ] **Step 5: Add restart and duplicate recovery tests**

Mock the Bridge so an existing `codexThreadId` resumes after the old Bridge session returns 404. Assert the same native thread id is sent to `/sessions`, the old mapping is retained when resume succeeds, and a missing native thread enters replacement-pending without immediate replacement.

- [ ] **Step 6: Run focused conversation tests**

```powershell
npm test -- --test-name-pattern="Codex dispatch|shared history|synthetic context|desktop turn|replacement"
```

Expected: all existing Codex dispatch tests and new projection/recovery tests pass.

- [ ] **Step 7: Commit the projection unit**

```powershell
git add lib/codex-thread-sync.ts lib/codex-conversation.ts tests/codex-thread-sync.test.ts tests/conversation-codex-dispatch.test.ts tests/codex-shared-history.test.ts
git commit -m "feat: project native Codex turns into Harness conversations"
```

## Task 4: Add durable background synchronization and lifecycle operations

**Files:**
- Create: `repos/jormungand/lib/codex-sync-worker.ts`
- Modify: `repos/jormungand/lib/hive-services.ts`
- Modify: `repos/jormungand/lib/codex-conversation.ts`
- Modify: `repos/jormungand/app/api/conversation/control/route.ts`
- Modify: `repos/jormungand/app/api/conversation/route.ts`
- Create: `repos/jormungand/tests/codex-sync-worker.test.ts`
- Modify: `repos/jormungand/tests/conversation-lifecycle-structure.test.ts`

- [ ] **Step 1: Write failing worker tests**

Use injected clock, repository, and Bridge functions so tests do not create real timers:

```ts
test("worker imports native Codex turns without a browser request", async () => {
  const worker = createCodexSyncWorker({
    repository,
    readThread: async () => codexDesktopSnapshot,
    now: () => "2026-08-23T00:00:00.000Z"
  })

  await worker.tick()

  assert.equal(repository.listConversation(conversationId)[0].content, "desktop message")
})

test("worker retains queued work on transient Bridge failure", async () => {
  const worker = createCodexSyncWorker({
    repository,
    readThread: async () => { throw new Error("bridge offline") }
  })

  await worker.tick()

  assert.equal(repository.getCodexSession(conversationId)?.mappingState, "offline")
  assert.equal(repository.getExecutionJob(jobId)?.status, "queued")
})
```

Add tests for 30-second polling configuration, no overlapping ticks, retry after recovery, archive/unarchive, and native deletion replacement-pending state.

- [ ] **Step 2: Run the tests and confirm RED**

```powershell
npm test -- --test-name-pattern="sync worker|Bridge failure|replacement-pending"
```

Expected: fail because the worker and mapping states are absent.

- [ ] **Step 3: Implement a non-overlapping worker**

Create `createCodexSyncWorker` with `tick()`, `start()`, and `stop()`. `tick()` must:

1. Read active mappings.
2. Reconcile each native thread through the Bridge.
3. Project unknown native items transactionally.
4. Mark transient failures offline and leave queued jobs untouched.
5. Mark missing native threads replacement-pending.
6. Never run two ticks concurrently.

`start()` uses `CODEX_SYNC_INTERVAL_MS` with a default below 30 seconds and calls `.unref()` on the timer when supported. Tests must inject the interval and timer functions.

- [ ] **Step 4: Start the worker from the service lifecycle**

Add the worker to `createHiveServices` with dependency injection for tests. `getDefaultHiveServices` must not create multiple workers. Keep the existing conversation dispatcher and manager scheduler behavior intact.

- [ ] **Step 5: Add lifecycle endpoints and state**

Wire `rename`, `archive`, `unarchive`, and confirmed `delete` through the existing control/management routes. Return `mappingState`, `nativeThreadId`, `nativeName`, `lastSyncAt`, and `syncWarning` in conversation state. A native-only deletion must return a warning without deleting Harness entries.

- [ ] **Step 6: Run worker/lifecycle regressions**

```powershell
npm test -- --test-name-pattern="sync worker|conversation lifecycle|Codex conversation"
```

Expected: worker, lifecycle, queue, and existing conversation tests pass.

- [ ] **Step 7: Commit the worker unit**

```powershell
git add lib/codex-sync-worker.ts lib/hive-services.ts lib/codex-conversation.ts app/api/conversation/control/route.ts app/api/conversation/route.ts tests/codex-sync-worker.test.ts tests/conversation-lifecycle-structure.test.ts
git commit -m "feat: synchronize Codex threads in the background"
```

## Task 5: Expose sync state in the Harness conversation UI

**Files:**
- Modify: `repos/jormungand/components/task-conversation.tsx`
- Modify: `repos/jormungand/app/globals.css` only if existing styles cannot express the status
- Modify: `repos/jormungand/tests/conversation-ui-structure.test.ts`
- Modify: `repos/jormungand/tests/conversation-ui-behavior.test.ts`

- [ ] **Step 1: Write failing UI tests**

Add assertions for these user-visible states:

```ts
test("shows native Codex sync status without focus controls", () => {
  const markup = readComponent()
  assert.match(markup, /Codex sync/)
  assert.match(markup, /Waiting for sync|Synced|Native thread replaced/)
  assert.doesNotMatch(markup, /focusCodex|bring.*foreground|window\.focus/) 
})
```

Add behavior tests that render `offline`, `replacement-pending`, and `queued` state labels and verify polling requests do not overlap.

- [ ] **Step 2: Run the tests and confirm RED**

```powershell
npm test -- --test-name-pattern="native Codex sync status|replacement|queued state"
```

Expected: fail because the new state labels and properties are absent.

- [ ] **Step 3: Implement minimal state rendering**

Add a compact status row to the existing Codex activity panel showing:

- Native thread name/id availability.
- `Synced`, `Waiting for sync`, `Offline — retrying`, or
  `Native thread replaced` state.
- Last sync timestamp when available.
- A warning when a replacement was created.

Do not add a button that focuses or opens the Codex desktop app. Reuse existing layout and responsive styles.

- [ ] **Step 4: Run frontend tests and build**

```powershell
npm test -- --test-name-pattern="conversation UI|Codex sync status"
npm run typecheck
npm run build
```

Expected: all UI tests pass, TypeScript has no new errors, and Next build exits 0.

- [ ] **Step 5: Commit the UI unit**

```powershell
git add components/task-conversation.tsx app/globals.css tests/conversation-ui-structure.test.ts tests/conversation-ui-behavior.test.ts
git commit -m "feat: show Codex thread synchronization state"
```

## Task 6: Quality gates, dev deployment, and browser evidence

**Files:**
- Modify only files required by failing verification.
- Create: `repos/jormungand/docs/superpowers/evidence/2026-08-23-codex-thread-sync-dev.md`

- [ ] **Step 1: Run the complete local verification set**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check main..dev
git status --short --branch
```

Record exact pre-existing failures separately. Do not fix unrelated dirty files or add logs.

- [ ] **Step 2: Run changed-code security review**

Review only the feature diff for:

- Bridge authentication and origin checks.
- No token/secret persistence in SQLite or thread prompts.
- No UAC/admin elevation path.
- Full-access mode not reachable through untrusted imported conversation text.
- Confirmed delete behavior and replacement warnings.
- Retry/idempotency not duplicating native turns.

- [ ] **Step 3: Deploy the committed `dev` branch**

Use the repository's existing Zeabur/dev deployment path. Verify the deployed revision is the feature commit and that `CODEX_BRIDGE_URL`, `CODEX_BRIDGE_TOKEN`, and site auth values are present without printing secret values.

- [ ] **Step 4: Verify through the in-app browser**

Using `https://harness-framework-dev.zeabur.app/`:

1. Create or select a Harness conversation.
2. Invoke Codex once and confirm the conversation receives a native thread id/name.
3. Confirm the thread is visible in the Codex desktop sidebar without Harness forcing focus.
4. Send a Codex-side message and confirm it appears in Harness within 30 seconds.
5. Send a Harness-side message and confirm it is present in the same native thread.
6. Exercise a controlled Bridge outage and confirm queued/waiting state plus recovery.
7. Capture replacement-warning behavior only with a disposable test conversation.

Use the supplied Zeabur service URL to inspect service revision, health, and deployment configuration. Do not delete production resources or modify unrelated services.

- [ ] **Step 5: Write evidence and final review**

Record URLs, timestamps, non-secret statuses, screenshots or browser observations, test commands, and any residual risk in `docs/superpowers/evidence/2026-08-23-codex-thread-sync-dev.md`.

- [ ] **Step 6: Commit verification evidence**

```powershell
git add docs/superpowers/evidence/2026-08-23-codex-thread-sync-dev.md
git commit -m "docs: record Codex thread sync dev verification"
```

## Plan self-review

- Spec coverage: mapping, resume, replacement lineage, bidirectional projection,
  30-second sync, FIFO, offline retry, naming, lifecycle, full-access boundary,
  lazy migration, UI status, local tests, security review, and dev browser
  validation each have an implementation or verification task.
- Placeholder scan: no TODO/TBD implementation steps are used; every task
  names concrete files, tests, commands, and expected outcomes.
- Type consistency: the durable native identity is consistently named
  `nativeThreadId`, `nativeTurnId`, and `nativeItemId`; the persisted Harness
  mapping continues to expose `codexThreadId` for compatibility.
- Explicit feasibility gate: cross-client single-turn behavior is tested before
  claiming the FIFO acceptance criterion is complete.
