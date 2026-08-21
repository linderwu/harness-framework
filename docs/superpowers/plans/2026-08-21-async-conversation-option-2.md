# Async Conversation Option 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make conversation submission durable and asynchronous so users can queue multiple messages, cancel the active response plus queued messages, and manage conversations while agents run.

**Architecture:** Persist each conversation command in SQLite-backed `execution_jobs`, with a per-conversation dispatcher that claims one job at a time and waits for the agent turn to reach a terminal state. The UI returns to an interactive state after the API accepts a command and uses the existing hydration/polling path for durable state.

**Tech Stack:** Next.js App Router route handlers, React client component, TypeScript, SQLite via `better-sqlite3`, existing Codex bridge events and execution-job lease infrastructure, Node test runner.

---

### Task 1: Lock the queue contract with failing domain tests

**Files:**
- Modify: `repos/jormungand/lib/hive-memory/types.ts`
- Test: `repos/jormungand/tests/conversation-queue.test.ts`

- [ ] **Step 1: Add tests for status and FIFO behavior**

```ts
test("conversation queue keeps messages FIFO and exposes canceled status", async () => {
  const queue = createConversationQueueFixture()
  const first = await queue.enqueue({ conversationId: "conversation:a", content: "first", idempotencyKey: "one" })
  const second = await queue.enqueue({ conversationId: "conversation:a", content: "second", idempotencyKey: "two" })

  assert.equal(first.status, "queued")
  assert.equal(second.status, "queued")
  assert.deepEqual(queue.listPending("conversation:a").map((entry) => entry.content), ["first", "second"])

  await queue.cancelPending("conversation:a")
  assert.deepEqual(queue.listPending("conversation:a"), [])
  assert.deepEqual(queue.listConversation("conversation:a").map((entry) => entry.status), ["canceled", "canceled"])
})
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing queue API**

Run: `npx tsc -p tsconfig.tests.json --pretty false`

Expected: FAIL because `conversation-queue.test.ts` and the `canceled`/`interrupted` status do not exist yet.

- [ ] **Step 3: Add the minimal conversation statuses**

Change `ConversationStatus` to:

```ts
export type ConversationStatus =
  | "queued"
  | "running"
  | "completed"
  | "interrupted"
  | "canceled"
  | "failed"
```

- [ ] **Step 4: Run the focused test again after the queue implementation tasks are complete**

Run: `npx tsc -p tsconfig.tests.json --pretty false`

Expected: the new queue assertions compile and later pass with the repository/dispatcher implementation.

### Task 2: Add durable queue persistence and per-conversation claim semantics

**Files:**
- Modify: `repos/jormungand/lib/hive-memory/schema.ts`
- Modify: `repos/jormungand/lib/hive-memory/types.ts`
- Modify: `repos/jormungand/lib/hive-memory/repository.ts`
- Modify: `repos/jormungand/lib/execution-jobs.ts`
- Modify: `repos/jormungand/lib/execution-job-runner.ts`
- Test: `repos/jormungand/tests/conversation-queue.test.ts`

- [ ] **Step 1: Test durable message/job creation and exclusive claims**

```ts
test("only one conversation dispatch job can run for a conversation", async () => {
  const fixture = await repositoryFixture()
  const first = await fixture.repository.createConversationDispatch({ conversationId: "conversation:a", entryId: "entry-1", idempotencyKey: "dispatch:one" })
  const second = await fixture.repository.createConversationDispatch({ conversationId: "conversation:a", entryId: "entry-2", idempotencyKey: "dispatch:two" })

  const claimed = await fixture.repository.claimNextConversationDispatch({ conversationId: "conversation:a", leaseOwner: "test", leaseDurationMs: 60_000 })
  assert.equal(claimed?.id, first.job.id)
  const blocked = await fixture.repository.claimNextConversationDispatch({ conversationId: "conversation:a", leaseOwner: "test-2", leaseDurationMs: 60_000 })
  assert.equal(blocked, undefined)
  assert.equal(second.job.status, "queued")
})
```

- [ ] **Step 2: Run the test and verify the exclusive-claim failure**

Run: `node --test .tmp-tests/tests/conversation-queue.test.js`

Expected: FAIL because the migration and repository claim method are absent.

- [ ] **Step 3: Add migration V7 and repository methods**

Add an index for conversation dispatch jobs and repository methods with these contracts:

```ts
createConversationDispatch(input: {
  conversationId: string
  entryId: string
  responseEntryId?: string
  idempotencyKey: string
}): Promise<{ job: ExecutionJob; inserted: boolean }>

claimNextConversationDispatch(input: {
  conversationId: string
  leaseOwner: string
  leaseDurationMs: number
}): Promise<ExecutionJob | undefined>

cancelQueuedConversationDispatches(conversationId: string): Promise<number>
renewExecutionJobLease(input: { id: string; leaseOwner: string; leaseDurationMs: number }): Promise<ExecutionJob>
```

The claim transaction must select the oldest queued `conversation_dispatch` job and return no job whenever a running `conversation_dispatch` job already exists for that conversation.

- [ ] **Step 4: Run the focused queue tests**

Run: `npm test -- --test-name-pattern "conversation queue|conversation dispatch"`

Expected: PASS for FIFO, idempotency, cancellation, and exclusive claim tests.

### Task 3: Implement the conversation dispatcher and cancellation lifecycle

**Files:**
- Create: `repos/jormungand/lib/conversation-dispatcher.ts`
- Modify: `repos/jormungand/lib/codex-conversation.ts`
- Modify: `repos/jormungand/lib/conversation.ts`
- Modify: `repos/jormungand/lib/hive-services.ts`
- Test: `repos/jormungand/tests/conversation-queue.test.ts`
- Test: `repos/jormungand/tests/conversation-lifecycle-structure.test.ts`

- [ ] **Step 1: Add failing tests for asynchronous dispatch and cancel race**

```ts
test("dispatcher waits for the active turn before sending the next queued message", async () => {
  const bridge = createDelayedBridgeFixture()
  const first = await enqueueConversationMessage(bridge, "first")
  const second = await enqueueConversationMessage(bridge, "second")

  await runConversationDispatch(first.job.id)
  assert.deepEqual(bridge.startedPrompts, ["first"])
  bridge.completeCurrentTurn()
  await runConversationDispatch(second.job.id)
  assert.deepEqual(bridge.startedPrompts, ["first", "second"])
})

test("interrupt preserves partial output and cancels queued messages", async () => {
  const result = await interruptConversation("conversation:a")
  assert.equal(result.active.status, "interrupted")
  assert.equal(result.active.content, "partial answer")
  assert.deepEqual(result.canceled.map((entry) => entry.status), ["canceled"])
})
```

- [ ] **Step 2: Run the new tests and verify they fail before dispatcher code exists**

Run: `node --test .tmp-tests/tests/conversation-queue.test.js .tmp-tests/tests/conversation-lifecycle-structure.test.js`

Expected: FAIL on missing dispatcher exports or on the current bridge-busy error when the second message is sent.

- [ ] **Step 3: Implement the dispatcher**

The dispatcher must:

1. Claim one `conversation_dispatch` job with a database lease.
2. Mark its user/agent entries `running`.
3. Invoke the existing Codex/OpenClaw dispatch path.
4. For Codex, poll bridge events until `completed`, `interrupted`, or `failed`, renewing the execution-job lease between polls.
5. Persist final/partial text and the terminal entry statuses.
6. Schedule the next queued job only after the current job reaches a terminal state.

The enqueue path must create user and response entries before creating the job, use the existing idempotency key, and return the durable entries without waiting for the agent.

- [ ] **Step 4: Implement cancellation**

`interruptConversation` must call the existing bridge interrupt endpoint when a turn is active, cancel every queued dispatch job for the conversation, mark their linked entries `canceled`, and prevent the dispatcher from starting another job. The active response keeps its `liveText` and becomes `interrupted` after the bridge emits its terminal event.

- [ ] **Step 5: Run dispatcher tests and verify the red-green result**

Run: `npm test -- --test-name-pattern "dispatcher|interrupt preserves"`

Expected: PASS with no second bridge turn started before the first reaches a terminal state.

### Task 4: Return immediately from APIs and allow management commands during execution

**Files:**
- Modify: `repos/jormungand/app/api/conversation/route.ts`
- Modify: `repos/jormungand/app/api/conversation/control/route.ts`
- Modify: `repos/jormungand/app/api/conversations/[id]/route.ts`
- Modify: `repos/jormungand/lib/conversation-management.ts`
- Test: `repos/jormungand/tests/conversation-route.test.ts`
- Test: `repos/jormungand/tests/conversation-management.test.ts`

- [ ] **Step 1: Add failing route tests**

```ts
test("POST conversation returns 202 and a job id without waiting for the agent", async () => {
  const response = await postConversation({ content: "queue me", idempotencyKey: "route-1" })
  assert.equal(response.status, 202)
  assert.equal((await response.json()).status, "queued")
})

test("interrupt route cancels queued work while preserving the active response", async () => {
  const response = await postControl({ action: "interrupt", conversationId: "conversation:a" })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).entries.some((entry: { status: string }) => entry.status === "canceled"), true)
})
```

- [ ] **Step 2: Run route tests and verify the current synchronous/bridge-busy failure**

Run: `node --test .tmp-tests/tests/conversation-route.test.js .tmp-tests/tests/conversation-management.test.js`

Expected: FAIL because POST waits for direct dispatch and the control/delete routes do not cancel conversation jobs.

- [ ] **Step 3: Wire POST to enqueue and schedule the dispatcher**

For both unbound and workflow conversations, validate the request, persist the message, create a `conversation_dispatch` job, start a best-effort background drain, and return `{ conversationId, status: "queued", jobId, userEntry, responseEntry }` with HTTP 202. Duplicate idempotency keys return the existing result with HTTP 200.

- [ ] **Step 4: Wire control and delete behavior**

Keep `resume` and `stop` behavior intact. Make `interrupt` cancel queued work. Make deleting a running conversation stop its session, cancel queued jobs, and only then remove the conversation records; the route must not reject solely because the session is running.

- [ ] **Step 5: Run route and management tests**

Run: `npm test -- --test-name-pattern "POST conversation|interrupt route|running conversation"`

Expected: PASS with immediate 202 responses and no lost idempotency state.

### Task 5: Unlock the React conversation UI and add regression coverage

**Files:**
- Modify: `repos/jormungand/components/task-conversation.tsx`
- Test: `repos/jormungand/tests/conversation-ui-behavior.test.ts`
- Test: `repos/jormungand/tests/conversation-ui-structure.test.ts`

- [ ] **Step 1: Add failing UI assertions**

```ts
test("conversation composer remains enabled while Codex is running", async () => {
  const markup = renderRunningConversation()
  const textarea = markup.match(/<textarea\b[^>]*>/)?.[0] ?? ""
  const send = markup.match(/<button class="primaryButton"[^>]*>/)?.[0] ?? ""
  assert.doesNotMatch(textarea, /disabled=""/)
  assert.doesNotMatch(send, /disabled=""/)
  assert.match(markup, /Cancel|Pause/)
})
```

- [ ] **Step 2: Run the UI test and verify it fails on `isTurnRunning` gates**

Run: `node --test .tmp-tests/tests/conversation-ui-behavior.test.js .tmp-tests/tests/conversation-ui-structure.test.js`

Expected: FAIL because the current textarea, Send button, and manager controls include `isTurnRunning` in `disabled`/lock conditions.

- [ ] **Step 3: Remove only the turn-running UI locks**

Keep loading, identity replacement, active mutation, and control-request locks. Remove `isTurnRunning` from `isConversationManagerLocked` and from composer `disabled` expressions. Keep the live panel interrupt/stop controls enabled and change the active-turn action label to clearly indicate interruption/cancellation.

- [ ] **Step 4: Handle queued/canceled states in optimistic reconciliation**

When POST returns 202, merge the server entries and job status without waiting for final response. Render canceled/interrupted status text and preserve the partial live response after polling.

- [ ] **Step 5: Run UI tests**

Run: `npm test -- --test-name-pattern "composer remains enabled|conversation manager"`

Expected: PASS with Send enabled during an active turn and conversation management controls still independently actionable.

### Task 6: Repair baseline compatibility, run full verification, and commit

**Files:**
- Modify: `repos/jormungand/lib/hive-services.ts` only if required to preserve existing test-facing aliases
- Modify: `repos/jormungand/tests/*` only for assertions whose contract changes from synchronous dispatch to durable queue
- Modify: `repos/jormungand/docs/*` only for implementation notes

- [ ] **Step 1: Re-run the complete test suite and record every failure**

Run: `npm test`

Expected: no TypeScript errors from stale `createHiveServices`/`routeUnboundConversation` references and no regression failures outside the queue contract.

- [ ] **Step 2: Run lint, typecheck, and production build**

Run: `npm run lint`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all commands exit with code 0.

- [ ] **Step 3: Inspect the diff and confirm no conflict markers or secrets**

Run: `rg -n "^(<<<<<<<|=======|>>>>>>>)" .`

Run: `git diff --check`

Expected: no conflict markers, whitespace errors, or unrelated generated files.

- [ ] **Step 4: Commit using the Lore protocol**

```text
Keep conversation controls responsive during agent execution

Persist conversation commands before dispatch and serialize each conversation through a durable worker so multiple messages, cancellation, and management actions remain safe while an agent turn is active.

Constraint: The Codex bridge rejects concurrent turns in one session
Rejected: Browser-only queue | lost on refresh and cannot coordinate tabs
Confidence: high
Scope-risk: moderate
Reversibility: clean
Directive: Keep queue ordering and cancellation in SQLite; do not move them into React state
Tested: Full test suite, lint, typecheck, production build
Not-tested: Multi-process worker failover under a production proxy
```

- [ ] **Step 5: Push the reviewed commit to remote `main`**

Run: `git fetch origin main`

Run: `git push origin HEAD:main`

Expected: remote `main` advances from the fetched tip without force-push.

