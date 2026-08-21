# Async Conversation Option 3 Future Plan

> **For agentic workers:** This is a future plan only. Do not implement it as part of the current Option 2 delivery.

**Goal:** Add near-real-time conversation and agent activity updates without replacing the durable queue or cancellation model from Option 2.

**Architecture:** Keep the Option 2 dispatcher and SQLite state as the source of truth. Add an authenticated SSE route that reads the existing bridge event cursor and emits ordered conversation events; the browser reconnects with `Last-Event-ID` and falls back to polling when the stream is unavailable.

**Tech Stack:** Next.js App Router streaming route, browser `EventSource`, existing Codex bridge cursor/events, SQLite conversation state, Node test runner.

---

### Task 1: Define the event envelope and cursor contract

**Files:**
- Create: `repos/jormungand/lib/conversation-events.ts`
- Modify: `repos/jormungand/lib/codex-conversation.ts`
- Test: `repos/jormungand/tests/conversation-events.test.ts`

- [ ] Define versioned events for `queued`, `running`, `assistant_delta`, `completed`, `interrupted`, `canceled`, and `failed`.
- [ ] Map bridge sequence numbers to SSE `id` values and reject regressing cursors.
- [ ] Test duplicate delivery, cursor gaps, and terminal event detection.

### Task 2: Add authenticated SSE transport

**Files:**
- Create: `repos/jormungand/app/api/conversation/events/route.ts`
- Modify: `repos/jormungand/lib/conversation-events.ts`
- Test: `repos/jormungand/tests/conversation-events-route.test.ts`

- [ ] Accept `conversationId` and `Last-Event-ID`.
- [ ] Stream ordered events with `text/event-stream`, heartbeat frames, and clean cancellation when the request closes.
- [ ] Enforce the same conversation identity and permission checks as the existing GET/POST routes.
- [ ] Return a bounded replay window, then send a hydration-required event if the cursor is too old.

### Task 3: Integrate the browser EventSource with polling fallback

**Files:**
- Modify: `repos/jormungand/components/task-conversation.tsx`
- Test: `repos/jormungand/tests/conversation-ui-behavior.test.ts`

- [ ] Open one source for the active conversation only.
- [ ] Merge delta events into live text and entry state without duplicating terminal events.
- [ ] Reconnect using the last received event ID.
- [ ] Resume the current polling loop when SSE errors or the stream is unsupported.

### Task 4: Verify load, reconnect, and operational behavior

**Files:**
- Modify: `repos/jormungand/docs/superpowers/specs/2026-08-21-async-conversation-design.md`
- Test: `repos/jormungand/tests/conversation-events-route.test.ts`

- [ ] Test 100+ concurrent streams, client disconnect cleanup, proxy heartbeat behavior, and reconnect after bridge restart.
- [ ] Confirm SSE never becomes the source of truth for queue ordering, cancellation, or final persistence.
- [ ] Measure reduced polling traffic and event delivery latency before enabling by default.

