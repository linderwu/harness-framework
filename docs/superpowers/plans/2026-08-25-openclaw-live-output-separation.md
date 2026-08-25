# OpenClaw Live Output Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep only `finalAssistantVisibleText` in the conversation and display the remaining OpenClaw response envelope inside a dedicated Live Agent session panel, stacked below Codex Live session in the lower-left rail.

**Architecture:** The OpenClaw bridge will normalize the provider envelope into a user-facing `output` plus bounded `responseDetails` with `finalAssistantVisibleText` removed. The server-side agent bridge will carry `responseDetails` only through the ephemeral live-event path. The conversation UI will portal both Codex and Agent panels to one dashboard-owned lower-left mount, in deterministic order, while conversation entries render only the normalized final text.

**Tech Stack:** Node.js OpenClaw bridge, TypeScript/Next.js, React portals, Server-Sent Events, Node test runner, TypeScript compiler.

---

## Analysis and constraints

- `repos/jormungand/scripts/openclaw-bridge.mjs` currently extracts `result.payloads[].text`, but the observed OpenClaw envelope exposes the answer as top-level `finalAssistantVisibleText`.
- `repos/jormungand/lib/agent-bridge.ts` currently accepts only `output` from the bridge response and publishes terminal status without response details.
- `repos/jormungand/app/api/conversation/live/route.ts` already provides a separate ephemeral SSE stream for agent live events.
- `repos/jormungand/components/task-conversation.tsx` portals the Codex panel through `codexActivityMount`, but renders `Live Agent session` directly inside the conversation component. This is why the Agent panel appears in the conversation column.
- `repos/jormungand/components/harness-dashboard.tsx` already owns the lower-left mount point, so the smallest safe layout fix is to portal both panels into that mount and preserve the order Codex first, Agent second.
- Existing live-event tests intentionally prevent arbitrary provider stdout and private fields from leaking. New response-details handling must remain bounded and must never put `finalAssistantVisibleText` into the live details payload.

## Success criteria

1. A response envelope containing `finalAssistantVisibleText` produces `output === finalAssistantVisibleText`.
2. The bridge response contains `responseDetails` without `finalAssistantVisibleText`.
3. The terminal Agent live event carries those response details; the conversation entry continues to use only `output`.
4. When both sessions are present, Codex Live session renders first and Live Agent session renders second inside the dashboard lower-left mount.
5. No Live Agent panel markup remains in the normal conversation flow when the shared mount is supplied.
6. Existing event lifecycle, security, typecheck, lint, test, and production build checks pass.

## File map

- Modify `repos/jormungand/scripts/openclaw-bridge.mjs`: recognize the OpenClaw envelope, extract `finalAssistantVisibleText`, and return sanitized response details.
- Modify `repos/jormungand/tests/openclaw-live-bridge.test.ts`: add a provider-envelope regression fixture and assertions for output/detail separation.
- Modify `repos/jormungand/lib/workflow.ts`: extend `AgentArtifactResult` with optional live-only `responseDetails`.
- Modify `repos/jormungand/lib/agent-bridge.ts`: accept bridge response details and attach them to the terminal Agent live event without changing persisted conversation body.
- Modify `repos/jormungand/lib/agent-live-events.ts`: normalize bounded terminal response details and preserve the existing arbitrary-field filtering.
- Modify `repos/jormungand/tests/agent-live-events.test.ts`: verify response details are bounded and exclude `finalAssistantVisibleText`.
- Modify `repos/jormungand/tests/agent-bridge-live.test.ts`: verify terminal live events receive response details while the result body remains final text.
- Modify `repos/jormungand/components/task-conversation.tsx`: rename the shared mount contract, portal Agent panel beside Codex panel, and render response details only in Live Agent session.
- Modify `repos/jormungand/components/harness-dashboard.tsx`: pass the dashboard-owned mount through the neutral `liveActivityMount` prop.
- Modify `repos/jormungand/app/globals.css`: make the lower-left mount a vertical stack with consistent gaps and responsive width constraints.
- Modify `repos/jormungand/tests/conversation-ui-structure.test.ts`: assert both panels use the shared mount and the Agent panel is not left inline.

## Execution tasks

### Task 1: Normalize the OpenClaw provider envelope

**Files:**
- Modify: `repos/jormungand/scripts/openclaw-bridge.mjs`
- Test: `repos/jormungand/tests/openclaw-live-bridge.test.ts`

- [x] **Step 1: Add a failing fake-provider case**

Add a fixture mode that emits an object containing `finalAssistantVisibleText`, `finalAssistantRawText`, `finalPromptText`, `executionTrace`, and `toolSummary`. Assert that the completed bridge response currently fails the desired contract because `output` is not the visible text and/or details are absent.

- [x] **Step 2: Run the focused test and verify the expected failure**

Run from `repos/jormungand`:

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern "finalAssistantVisibleText" .tmp-tests/tests/openclaw-live-bridge.test.js
```

Expected: the new regression assertion fails because the current parser does not read the top-level visible-text field.

- [x] **Step 3: Implement minimal envelope extraction**

Add a helper that finds a structured record with a non-empty `finalAssistantVisibleText`, returns that value as the normal output, and creates `responseDetails` from the same record after removing only `finalAssistantVisibleText`. Preserve existing `result.payloads`, assistant-fragment, think-block, and private-stdout safeguards for other provider formats.

- [x] **Step 4: Run the focused bridge tests**

Run:

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern "OpenClaw bridge|finalAssistantVisibleText" .tmp-tests/tests/openclaw-live-bridge.test.js
```

Expected: all matching bridge tests pass and existing private-output assertions remain green.

### Task 2: Carry response details through the live-only server contract

**Files:**
- Modify: `repos/jormungand/lib/workflow.ts`
- Modify: `repos/jormungand/lib/agent-bridge.ts`
- Modify: `repos/jormungand/lib/agent-live-events.ts`
- Test: `repos/jormungand/tests/agent-live-events.test.ts`
- Test: `repos/jormungand/tests/agent-bridge-live.test.ts`

- [x] **Step 1: Add failing contract assertions**

Assert that a bridge response with `responseDetails` produces an AgentArtifactResult whose `body` is still the final visible answer and whose terminal live event has details without `finalAssistantVisibleText`. Add an oversized details case that verifies the live payload is bounded.

- [x] **Step 2: Run focused tests and verify failure**

Run:

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern "response details|terminal live event|bounded" .tmp-tests/tests/agent-live-events.test.js .tmp-tests/tests/agent-bridge-live.test.js
```

Expected: the new assertions fail because the current bridge response type and live event normalization discard response details.

- [x] **Step 3: Implement the live-only response-details path**

Add optional `responseDetails` to the agent result and bridge response types. Pass it through `bridgeResponseToAgentResult`, then include it only on the terminal live event emitted by `publishFinal`. Extend live-event normalization with a bounded `details` object and remove `finalAssistantVisibleText` defensively before publishing.

- [x] **Step 4: Run focused server tests**

Run:

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern "agent-live-events|agent bridge live|response details|terminal live event" .tmp-tests/tests/agent-live-events.test.js .tmp-tests/tests/agent-bridge-live.test.js
```

Expected: all matching tests pass; persisted `AgentArtifactResult.body` remains the final text.

### Task 3: Portal and align both Live session panels

**Files:**
- Modify: `repos/jormungand/components/task-conversation.tsx`
- Modify: `repos/jormungand/components/harness-dashboard.tsx`
- Modify: `repos/jormungand/app/globals.css`
- Test: `repos/jormungand/tests/conversation-ui-structure.test.ts`

- [x] **Step 1: Add failing UI structure assertions**

Assert that the shared mount uses a neutral `liveActivityMount` contract, that both Codex and Agent panel render paths use it, and that the inline Agent panel is not rendered directly before `.conversationEntries` when the mount is available.

- [x] **Step 2: Run the focused UI tests and verify failure**

Run:

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern "shared live mount|lower-left|Live Agent session" .tmp-tests/tests/conversation-ui-structure.test.js
```

Expected: the new source-contract assertions fail because only the Codex panel is currently portaled.

- [x] **Step 3: Implement the shared mount and deterministic order**

Rename the prop/state contract from `codexActivityMount` to `liveActivityMount`. Create a second portal render value for the Agent panel. Keep the JSX order as Codex panel first, Agent panel second so the lower-left mount always stacks them in that order. Preserve inline fallback only when no mount prop is supplied for isolated component use.

- [x] **Step 4: Move OpenClaw response details into the Agent panel**

Render terminal `details` in an expandable, scrollable `<pre>` inside Live Agent session. Keep conversation entries bound to the existing `entry.content`, which is populated from `result.body`; do not render raw bridge response fields in the conversation list.

- [x] **Step 5: Apply shared stack layout**

Make `.codexActivityMount` a vertical stack with a consistent gap, `min-width: 0`, and bottom alignment. Reuse the existing panel width and responsive drawer behavior; do not introduce fixed widths. Keep long JSON wrapped or scrollable inside the panel.

- [x] **Step 6: Run focused UI tests**

Run:

```powershell
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern "shared live mount|lower-left|Live Agent session|activity panel" .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/conversation-ui-behavior.test.js
```

Expected: all matching structure and behavior tests pass.

### Task 4: Full verification, review, commit, and push

**Files:**
- Review only the files listed above; do not stage existing unrelated `.omx`, logs, data, or documentation changes.

- [x] **Step 1: Run full tests and static checks**

From `repos/jormungand` run:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

Result: the 72 directly related tests pass; `typecheck` and `build` pass; lint has 0 errors and 15 pre-existing warnings. The full 456-test sweep reports 444 passes and 12 unrelated baseline failures in agent roster, execution-job schema, other dashboard contracts, and legacy CSS contracts.

- [x] **Step 2: Review the diff and security boundary**

Confirm that `finalAssistantVisibleText` is absent from `responseDetails`, that conversation content comes from `output/body`, that live details are bounded, and that no unrelated user files are staged.

- [x] **Step 3: Request code review before merging**

Review the final diff against the pre-change commit. Fix any Critical or Important findings before committing.

Result: the delegated reviewer timed out without findings; the final staged diff was manually reviewed for output separation, bounded live details, portal order, and unrelated staged files.

- [ ] **Step 4: Commit only intentional files**

```powershell
git add repos/jormungand/scripts/openclaw-bridge.mjs repos/jormungand/tests/openclaw-live-bridge.test.ts repos/jormungand/lib/workflow.ts repos/jormungand/lib/agent-bridge.ts repos/jormungand/lib/agent-live-events.ts repos/jormungand/tests/agent-live-events.test.ts repos/jormungand/tests/agent-bridge-live.test.ts repos/jormungand/components/task-conversation.tsx repos/jormungand/components/harness-dashboard.tsx repos/jormungand/app/globals.css repos/jormungand/tests/conversation-ui-structure.test.ts docs/superpowers/plans/2026-08-25-openclaw-live-output-separation.md
git commit -m "fix: separate OpenClaw response and live output"
```

- [ ] **Step 5: Push the verified commit to main**

After confirming the remote state and that the push is a fast-forward or otherwise non-destructive update:

```powershell
git push origin HEAD:main
```

Report the commit SHA, pushed ref, verification commands, and any unrelated files intentionally left untouched.

## Plan self-review

- Every user requirement maps to a task: final-text-only conversation, both panels in the lower-left, deterministic vertical order, and other response data in Live Agent session.
- The plan keeps existing SSE transport and conversation persistence; it changes only the missing response-details field and the incorrect Agent panel mount.
- No placeholder steps remain; each implementation step names exact files, tests, and commands.
- The plan retains existing private-output filtering and adds a defense-in-depth removal of `finalAssistantVisibleText` at live-event normalization.
