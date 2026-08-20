# OpenClaw Live reasoning preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded live-event path so the Jormungand Live Agent session can show OpenClaw activity and optional provider-emitted reasoning previews during a run.

**Architecture:** OpenClaw bridge events are normalized into a shared `AgentLiveEvent` contract. The server publishes bounded per-conversation events through an in-process bus and an SSE route; the browser subscribes before dispatching an OpenClaw message. The bridge remains the source of truth for what OpenClaw actually emits, with safe status fallback when no reasoning/event stream is available.

**Tech Stack:** TypeScript, Next.js route handlers, browser `EventSource`, Web Streams SSE, Node child-process bridge, Node test runner, existing SQLite/Hive services. No new dependency.

---

## File map

- Create `repos/jormungand/lib/agent-live-events.ts`: shared event types, normalization, bounded text, and reasoning extraction.
- Create `repos/jormungand/lib/agent-live-bus.ts`: bounded in-process publish/subscribe/replay lifecycle.
- Create `repos/jormungand/app/api/conversation/live/route.ts`: conversation-scoped SSE projection.
- Create `repos/jormungand/tests/agent-live-events.test.ts`: pure normalization and extraction tests.
- Create `repos/jormungand/tests/agent-live-bus.test.ts`: ordering, replay, unsubscribe, and terminal cleanup tests.
- Create `repos/jormungand/tests/conversation-live-route.test.ts`: SSE framing and scoping tests.
- Modify `repos/jormungand/scripts/openclaw-bridge.mjs`: bounded run journal, events endpoint, lifecycle events, and structured reasoning parsing.
- Modify `repos/jormungand/lib/agent-bridge.ts`: publish lifecycle events and poll the OpenClaw event endpoint while the final request is in flight.
- Modify `repos/jormungand/components/task-conversation.tsx`: subscribe to OpenClaw live events and render a generic Live Agent panel with collapsed reasoning preview.
- Modify `repos/jormungand/tests/agent-bridge-source.test.ts`: verify bridge event endpoint and capability contract.
- Modify `repos/jormungand/tests/conversation-ui-structure.test.ts` and/or `conversation-ui-behavior.test.ts`: verify OpenClaw subscription and reasoning disclosure.
- Modify `repos/jormungand/README.md`: document optional live-event behavior and limits.

### Task 1: Define and test the shared live-event contract

**Files:**
- Create: `repos/jormungand/lib/agent-live-events.ts`
- Test: `repos/jormungand/tests/agent-live-events.test.ts`

- [ ] **Step 1: Write the failing tests.** Add tests for these exact behaviors:

```ts
test("normalizes a provider reasoning frame without exposing arbitrary fields", () => {
  const event = normalizeAgentLiveEvent({
    sequence: 4,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "reasoning",
    text: "Checking the repository",
    metadata: { secret: "must-not-survive" }
  })
  assert.deepEqual(event, {
    sequence: 4,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "reasoning",
    text: "Checking the repository"
  })
})

test("extracts only explicit closed reasoning blocks", () => {
  assert.equal(extractReasoningText({ reasoning: "structured" }), "structured")
  assert.equal(extractReasoningText({ text: "<think>inline</think>answer" }), "inline")
  assert.equal(extractReasoningText({ text: "ordinary log output" }), undefined)
})

test("bounds event text and rejects invalid identity", () => {
  assert.throws(() => normalizeAgentLiveEvent({ conversationId: "", agentId: "codex", type: "status" }))
  const event = normalizeAgentLiveEvent({
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "status",
    message: "x".repeat(20_000)
  })
  assert.equal(event.message?.length, MAX_AGENT_LIVE_TEXT)
})
```

- [ ] **Step 2: Run the focused test and verify RED.**

Run from `repos/jormungand`:

```bash
npm test -- --test-name-pattern="reasoning|event text|provider reasoning"
```

Expected: FAIL because the contract module and exports do not exist.

- [ ] **Step 3: Implement the minimal contract.** Export:

```ts
export const MAX_AGENT_LIVE_TEXT = 8_000
export const MAX_AGENT_LIVE_EVENTS = 64
export type AgentLiveEventType =
  | "started" | "status" | "tool" | "assistant_delta"
  | "reasoning" | "completed" | "failed"
export interface AgentLiveEvent {
  id: string
  sequence: number
  conversationId: string
  agentId: AgentKind
  type: AgentLiveEventType
  message?: string
  text?: string
  delta?: string
  createdAt: string
  metadata?: { runId?: string; source?: string; phase?: string }
}
export function normalizeAgentLiveEvent(input: unknown): AgentLiveEvent
export function extractReasoningText(input: unknown): string | undefined
```

The implementation must trim identity/ordinary display strings and cap all text, preserve exact whitespace for `assistant_delta` delta/text/message payloads, allow only declared metadata keys, require a non-empty conversation id and agent id, and throw for unsupported event types. `extractReasoningText` prefers explicit `reasoning`, `thinking`, or `reasoning_content`; closed `<think>...</think>` is a fallback.

- [ ] **Step 4: Run focused tests and existing event-related tests.**

```bash
npm test -- --test-name-pattern="reasoning|event text|provider reasoning|conversation event"
```

Expected: PASS with zero failures.

- [ ] **Step 5: Commit.**

```bash
git add lib/agent-live-events.ts tests/agent-live-events.test.ts
git commit -m "Add bounded live agent event contract" -m "Normalize OpenClaw and Codex-compatible live frames before they reach the UI." -m "Constraint: Reasoning may be sensitive and is not guaranteed by the provider." -m "Rejected: Forward arbitrary stdout | logs and tool data are not reasoning." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: focused live-event tests" -m "Not-tested: bridge integration"
```

### Task 2: Add the bounded in-process event bus and SSE route

**Files:**
- Create: `repos/jormungand/lib/agent-live-bus.ts`
- Create: `repos/jormungand/app/api/conversation/live/route.ts`
- Test: `repos/jormungand/tests/agent-live-bus.test.ts`
- Test: `repos/jormungand/tests/conversation-live-route.test.ts`

- [ ] **Step 1: Write failing bus tests.** Cover:

```ts
test("replays only the bounded recent window and preserves sequence order", () => {
  const bus = createAgentLiveBus({ maxEvents: 2 })
  bus.publish(event("status", 1))
  bus.publish(event("status", 2))
  bus.publish(event("status", 3))
  assert.deepEqual(bus.snapshot("conversation-1").map((item) => item.sequence), [2, 3])
})

test("unsubscribe stops future delivery and terminal events close the stream", () => {
  const bus = createAgentLiveBus()
  const received: AgentLiveEvent[] = []
  const subscription = bus.subscribe("conversation-1", (item) => received.push(item))
  bus.publish(event("started", 1))
  subscription.unsubscribe()
  bus.publish(event("completed", 2))
  assert.deepEqual(received.map((item) => item.sequence), [1])
  assert.equal(bus.isTerminal("conversation-1"), true)
})
```

- [ ] **Step 2: Run the focused tests and verify RED.**

```bash
npm test -- --test-name-pattern="bounded recent window|unsubscribe|terminal"
```

Expected: FAIL because the bus does not exist.

- [ ] **Step 3: Implement the bus.** Export `createAgentLiveBus`, `publishAgentLiveEvent`, `subscribeAgentLiveEvents`, and `getAgentLiveSnapshot`. Use a per-conversation Map containing at most `MAX_AGENT_LIVE_EVENTS`, listeners, terminal state, and an idle cleanup timer. Ignore duplicate or regressed sequences. Do not write to SQLite.

- [ ] **Step 4: Write failing SSE route tests.** Export `formatAgentLiveSse(eventName, payload)` and assert it produces:

```text
event: agent-live
data: {"type":"status",...}

```

Also assert missing `conversationId` is rejected, the response is `text/event-stream`, and only the requested conversation's events are emitted.

- [ ] **Step 5: Implement the route.** `GET /api/conversation/live?conversationId=...` requires an explicit id, emits `ready`, replays the bounded snapshot, then awaits new events. Use `ReadableStream` and headers `cache-control: no-cache, no-transform`, `connection: keep-alive`, and `content-type: text/event-stream; charset=utf-8`. On request cancellation unsubscribe; on terminal event close after flushing it. Never include bridge tokens or raw frames.

- [ ] **Step 6: Run focused tests and commit.**

```bash
npm test -- --test-name-pattern="bounded recent window|unsubscribe|terminal|agent-live|text/event-stream"
git add lib/agent-live-bus.ts app/api/conversation/live/route.ts tests/agent-live-bus.test.ts tests/conversation-live-route.test.ts
git commit -m "Stream bounded live agent events to conversations" -m "Add an in-process replayable bus and conversation-scoped SSE projection for live agent activity." -m "Constraint: Live events are ephemeral and must not become durable transcript data." -m "Rejected: Polling from the browser | SSE preserves ordering and avoids a second polling loop." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: bus and SSE route tests" -m "Not-tested: OpenClaw bridge source"
```

### Task 3: Make the OpenClaw bridge publish safe live events

**Files:**
- Modify: `repos/jormungand/scripts/openclaw-bridge.mjs`
- Modify: `repos/jormungand/tests/agent-bridge-source.test.ts`
- Create or modify: `repos/jormungand/tests/openclaw-live-bridge.test.ts`

- [ ] **Step 1: Write failing bridge tests/source assertions.** Assert the bridge source contains:

```ts
/agent-runs\/by-idempotency\/:key\/events/
live-events
appendRunEvent
reasoning_content
<think>
```

Add a fixture test proving a structured record emits `reasoning` without exposing arbitrary stderr, tool arguments, or unrelated fields.

- [ ] **Step 2: Run focused bridge tests and verify RED.**

```bash
npm test -- --test-name-pattern="OpenClaw.*live|live-events|reasoning_content"
```

Expected: FAIL because the endpoint and journal are absent.

- [ ] **Step 3: Add a bounded journal.** Replace the current active-run value with a record containing `id`, `idempotencyKey`, `workflowRunId`, `status`, `nextCursor`, `events`, and `cancel`. Add `appendRunEvent(run, event)` that stores no more than 64 normalized events and increments `nextCursor` monotonically.

- [ ] **Step 4: Add the events endpoint.** Handle `GET /agent-runs/by-idempotency/:key/events?after=<cursor>` and return:

```json
{
  "id": "run-id",
  "status": "running",
  "events": [],
  "nextCursor": 3
}
```

Return `404` for unknown keys and never return raw stdout/stderr or the full request message.

- [ ] **Step 5: Emit and parse events.** Emit `started` before docker spawn and `completed`/`failed` after process close. When stdout contains complete JSON records, inspect only explicit reasoning fields (`reasoning`, `thinking`, `reasoning_content`, typed `stream: "thinking"`) and closed `<think>` blocks. Emit bounded `assistant_delta` only for explicit text/delta fields; never treat arbitrary chunks as user-visible content. Keep existing final `output` behavior unchanged.

- [ ] **Step 6: Advertise capability and cleanup.** Add `live-events` to `bridgeCapabilities()`, retain `text-output`, and delete the journal after the existing completed-run TTL. Ensure cancel/stop still append terminal events.

- [ ] **Step 7: Run bridge tests and commit.**

```bash
npm test -- --test-name-pattern="OpenClaw.*live|live-events|reasoning_content|bridge capability"
git add scripts/openclaw-bridge.mjs tests/agent-bridge-source.test.ts tests/openclaw-live-bridge.test.ts
git commit -m "Expose bounded OpenClaw live events" -m "Let the bridge publish lifecycle and explicitly structured reasoning frames without leaking raw process output." -m "Constraint: The current CLI may not provide reasoning deltas during generation." -m "Rejected: Forward stdout verbatim | stdout can contain prompts, logs, tool data, and secrets." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: bridge source and parser fixtures" -m "Not-tested: Docker/OpenClaw runtime"
```

### Task 4: Poll bridge events while OpenClaw runs

**Files:**
- Modify: `repos/jormungand/lib/agent-bridge.ts`
- Test: `repos/jormungand/tests/agent-bridge-live.test.ts`

- [ ] **Step 1: Write failing tests.** Mock `fetch` with a blocked final `/agent-runs` promise and a sequence of event responses. Assert `invokeConfiguredAgent` publishes started, reasoning, and completed events in order; assert a 404 events endpoint falls back without failing the result; assert regressed cursors are ignored.

- [ ] **Step 2: Run focused tests and verify RED.**

```bash
npm test -- --test-name-pattern="publishes started|reasoning.*completed|events endpoint.*fallback|regressed cursor"
```

Expected: FAIL because `invokeConfiguredAgent` currently waits only for the final response.

- [ ] **Step 3: Implement the poller.** Add private `pollOpenClawLiveEvents` that starts after the POST is initiated, calls `/agent-runs/by-idempotency/<key>/events?after=<cursor>` every 500 ms, accepts only forward cursors, maps bridge records through `normalizeAgentLiveEvent`, and stops on terminal status, fetch failure, 404, or a 15-minute deadline. Publish only when `input.conversationId` exists. Do not delay or fail the final request because the optional stream is unavailable.

- [ ] **Step 4: Publish lifecycle fallbacks.** Publish `started` before the OpenClaw request and `failed`/`completed` after the result is mapped. Avoid duplicate terminal events when the bridge already supplied one.

- [ ] **Step 5: Run focused and regression tests, then commit.**

```bash
npm test -- --test-name-pattern="publishes started|reasoning.*completed|events endpoint.*fallback|regressed cursor|agent bridge"
git add lib/agent-bridge.ts tests/agent-bridge-live.test.ts
git commit -m "Relay OpenClaw live events during agent calls" -m "Poll the optional bridge event journal concurrently with the final request and publish normalized events to conversations." -m "Constraint: Live transport is advisory and cannot break final agent execution." -m "Rejected: Make event polling mandatory | older bridges must remain compatible." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: mocked concurrent bridge polling and existing agent bridge tests" -m "Not-tested: remote bridge latency"
```

### Task 5: Subscribe and render OpenClaw activity in the Live Agent UI

**Files:**
- Modify: `repos/jormungand/components/task-conversation.tsx`
- Modify: `repos/jormungand/tests/conversation-ui-structure.test.ts`
- Modify: `repos/jormungand/tests/conversation-ui-behavior.test.ts`

- [ ] **Step 1: Write failing UI tests.** Assert the source contains an `EventSource` subscription to `/api/conversation/live`, a cleanup path, a `Reasoning preview` disclosure, and that Codex `Pause`, `Continue`, and `Stop` controls remain unchanged. Add a behavior test that reasoning is hidden until disclosure is opened and an OpenClaw status event remains visible.

- [ ] **Step 2: Run focused UI tests and verify RED.**

```bash
npm test -- --test-name-pattern="EventSource|Reasoning preview|Pause|Continue|Stop|OpenClaw status"
```

Expected: FAIL because the component currently renders only Codex `session`/`events` state.

- [ ] **Step 3: Add OpenClaw live state.** Add state for `agentLiveEvents`, `agentLiveReasoning`, `agentLiveStatus`, and the active `EventSource`. Start the source before submitting a non-Codex message; parse `agent-live` JSON; append bounded normalized events; update status and reasoning separately; close on terminal event or request-generation change; close on unmount and conversation switch.

- [ ] **Step 4: Generalize the panel without changing Codex semantics.** Render when either existing Codex session exists or an OpenClaw live stream is active. Use `Live Agent session`, display selected agent label, keep Codex controls under existing conditions, list status/tool/assistant events, and render only when reasoning exists:

```tsx
<details>
  <summary>Reasoning preview</summary>
  <pre>{agentLiveReasoning}</pre>
</details>
```

Do not insert reasoning into `conversationEntries`.

- [ ] **Step 5: Run UI and full test suite, then commit.**

```bash
npm test -- --test-name-pattern="EventSource|Reasoning preview|Pause|Continue|Stop|OpenClaw status|conversation UI"
git add components/task-conversation.tsx tests/conversation-ui-structure.test.ts tests/conversation-ui-behavior.test.ts
git commit -m "Display OpenClaw activity in the live agent panel" -m "Subscribe before dispatch so OpenClaw status and optional reasoning previews are visible during a run without changing durable conversation entries." -m "Constraint: Reasoning is opt-in and ephemeral." -m "Rejected: Persist reasoning as conversation content | it is sensitive and not guaranteed to be complete." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: UI behavior and structure tests" -m "Not-tested: browser manual stream against remote OpenClaw"
```

### Task 6: Document behavior and run the full verification gate

**Files:**
- Modify: `repos/jormungand/README.md`
- Verify: repository-wide

- [ ] **Step 1: Update documentation.** Document `live-events` as optional, explain that `/reasoning stream` depends on OpenClaw model/channel support, and state that the UI falls back to status events. Do not document hidden chain-of-thought access.

- [ ] **Step 2: Run the full verification suite.**

```bash
npm run test
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0. If any fail, dispatch a focused fix subagent and rerun the failed command plus the full suite.

- [ ] **Step 3: Inspect the final diff and security boundaries.**

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
```

Confirm no private OpenClaw state paths, bridge tokens, raw stderr, arbitrary stdout, or new dependency were added.

- [ ] **Step 4: Commit documentation and final verification record.**

```bash
git add README.md
git commit -m "Document OpenClaw live event limitations" -m "Explain the optional reasoning preview and the safe activity fallback so operators do not confuse it with complete hidden model reasoning." -m "Constraint: Provider capabilities vary by OpenClaw channel and model." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: test, typecheck, lint, and build" -m "Not-tested: live remote Gateway session"
```

## Completion handoff

After all tasks are complete, dispatch a final code-review subagent against `main...HEAD`. Resolve every Critical or Important finding, rerun the full verification gate, then use the finishing-a-development-branch workflow to merge the feature branch into `main`, verify the merged result, push `main` to `origin`, and report the pushed commit SHA. Preserve unrelated dirty changes that were present on the original `main` worktree.
