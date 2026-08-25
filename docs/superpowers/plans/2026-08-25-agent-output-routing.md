# Agent Output Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route OpenClaw/Lucky final text and reasoning to the correct Conversation/Live Agent surfaces, and restore Codex live activity for bound workflow conversations.

**Architecture:** Normalize Lucky and Codex bridge journal records at the bridge boundary, reuse the existing agent live bus/SSE relay, and pass the workflow conversation ID through the dispatcher. Keep native Codex session state separate from bridge-backed live activity so one provider's panel cannot hide another provider's panel.

**Tech Stack:** TypeScript, Node.js ESM bridge scripts, Next.js App Router, Node test runner, SQLite-backed conversation state, SSE live events.

---

### Task 1: Lock the output-routing seams with failing tests

**Files:**
- Modify: `repos/jormungand/tests/agent-live-events.test.ts`
- Modify: `repos/jormungand/tests/agent-bridge-live.test.ts`
- Modify: `repos/jormungand/tests/conversation-ui-behavior.test.ts`
- Modify: `repos/jormungand/tests/conversation-ui-structure.test.ts`
- Add or modify: `repos/jormungand/tests/lucky-live-bridge.test.ts`

- [ ] **Step 1: Add a Lucky record expectation.** Assert that a Lucky journal record with `data.text: "<think>private</think>visible"` normalizes to a `reasoning` event containing `private` and an `assistant_delta` containing `visible`, and that a final response body contains only `visible`.
- [ ] **Step 2: Add a bound relay expectation.** Extend the live relay test fixture to invoke `mavis` and bound `codex` with `conversationId`, then assert the event bus receives `started`, observable output/reasoning, and terminal events.
- [ ] **Step 3: Add bound UI expectations.** Assert that bridge-backed live activity is not restricted to `isUnbound`, while the native Codex panel remains available whenever a session exists.
- [ ] **Step 4: Run focused tests and verify RED.**

Run from `repos/jormungand`:

```powershell
npm test -- --test-name-pattern="Lucky|bound|live|Codex"
```

Expected: failures showing missing Lucky event normalization/stripping, missing bound relay routing, or the current unbound-only UI gate.

### Task 2: Implement Lucky final/reasoning separation

**Files:**
- Modify: `repos/jormungand/scripts/lucky-mavis-server.mjs`
- Modify: `repos/jormungand/lib/agent-bridge.ts`
- Test: `repos/jormungand/tests/lucky-live-bridge.test.ts`

- [ ] **Step 1: Add bounded think helpers in the Lucky bridge.** Extract all closed `<think>...</think>` blocks, return visible text with those blocks removed, and preserve non-think text exactly enough for final response compatibility.
- [ ] **Step 2: Emit normalized Lucky journal records.** Add `sequence`, flat `text`/`delta`/`message` fields, and `reasoning`/`assistant_delta` event types while retaining the existing nested `data` journal payload.
- [ ] **Step 3: Strip think blocks from the final `output`.** Apply the visible-text helper to the last assistant content before returning `status: "completed"`.
- [ ] **Step 4: Teach `agent-bridge.ts` to read flat or nested provider records.** Accept `sequence` or `cursor`, and read event text from the record or its `data` object without leaking final-only fields.
- [ ] **Step 5: Run the Lucky-focused tests and verify GREEN.**

```powershell
npm test -- --test-name-pattern="Lucky|agent live record|think"
```

### Task 3: Restore bridge-backed live relay coverage

**Files:**
- Modify: `repos/jormungand/lib/agent-bridge.ts`
- Modify: `repos/jormungand/lib/conversation.ts`
- Modify: `repos/jormungand/lib/hive-services.ts`
- Modify: `repos/jormungand/scripts/codex-bridge.mjs`
- Modify: `repos/jormungand/tests/agent-bridge-live.test.ts`
- Modify: `repos/jormungand/tests/codex-conversation-structure.test.ts`

- [ ] **Step 1: Pass `conversationId` through bound conversation dispatch.** Add it to the dependency type and both invocation call sites, then forward it from `hive-services.ts` to `invokeConfiguredAgent`.
- [ ] **Step 2: Generalize the live relay eligibility.** Rename the OpenClaw-only relay concept to bridge-backed agent relay and allow `openclaw`, `mavis`, and bound `codex`; keep unbound Codex on native session mode.
- [ ] **Step 3: Add bounded Codex one-shot live journal events.** Publish lifecycle and observable stdout/terminal events, add `/agent-runs/by-idempotency/:key/events` replay, and keep output/event buffers bounded.
- [ ] **Step 4: Run relay and Codex tests and verify GREEN.**

```powershell
npm test -- --test-name-pattern="agent bridge live|Codex bridge|conversation dispatch"
```

### Task 4: Fix Conversation live panel visibility

**Files:**
- Modify: `repos/jormungand/components/task-conversation.tsx`
- Modify: `repos/jormungand/tests/conversation-ui-behavior.test.ts`
- Modify: `repos/jormungand/tests/conversation-ui-structure.test.ts`

- [ ] **Step 1: Open bridge-backed SSE for bound Codex and Lucky.** Keep native unbound Codex on its existing session path.
- [ ] **Step 2: Remove the `isUnbound` gate from the bridge-backed Live Agent panel.** Keep `isUnbound && session` only for native Codex session rendering.
- [ ] **Step 3: Preserve separate panel rendering.** Render bridge-backed activity and native Codex activity independently so one does not suppress the other.
- [ ] **Step 4: Verify bounded text and responsive structure.** Keep the current capped event list, `min-width: 0`, and existing mobile stacking behavior.
- [ ] **Step 5: Run UI-focused tests and verify GREEN.**

```powershell
npm test -- --test-name-pattern="conversation UI|Codex activity|agent live"
```

### Task 5: Full verification and handoff

**Files:**
- No new production files.

- [ ] **Step 1: Run the complete test suite.** `npm test`
- [ ] **Step 2: Run static checks.** `npm run typecheck` and `npm run lint`
- [ ] **Step 3: Run the production build.** `npm run build`
- [ ] **Step 4: Inspect `git diff --check` and review only intended files.**
- [ ] **Step 5: Run a redacted end-to-end bridge smoke check if services are available.** Verify final text excludes `<think>` and the live stream includes a reasoning event; do not execute mutating prompts.
- [ ] **Step 6: Commit implementation separately from the design/plan documents.**

```powershell
git diff --check
git status --short
git commit -m "fix: route agent final and live output separately"
```
