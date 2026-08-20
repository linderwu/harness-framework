# Unbound Full Agent Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated unbound conversations dispatch directly to Codex or OpenClaw without project binding, manager routing, or the `conversation.unbound_limited` read-only guard.

**Architecture:** Keep conversation persistence, per-agent history synchronization, bridge authentication, and audit behavior unchanged. Replace the two-branch unbound router with one direct-dispatch helper that creates only a synthetic invocation envelope and sends a non-restrictive unbound skill to the selected agent. Leave `JORMUNGAND_AGENT_PERMISSION_MODE` as the runtime sandbox switch; `full` remains necessary for Codex filesystem/network access.

**Tech Stack:** TypeScript, Next.js server modules, Node test runner, Codex/OpenClaw HTTP or A2A bridges, SQLite-backed Hive memory.

---

## File map and worktree rules

- Modify `lib/hive-services.ts` to remove the Codex manager-binding detour and expose one direct unbound route for both agent families.
- Modify `tests/conversation-lifecycle-structure.test.ts` with behavior-first coverage for Codex direct dispatch, OpenClaw skill payloads, history delivery, and failure handling.
- Modify `README.md` to document direct unbound execution and the server-side authentication boundary.
- Do not modify the existing unrelated working-tree changes shown by `git status`; stage only files named by each task.
- Do not change `lib/agent-bridge.ts`, bridge authentication, or project-bound workflow routing unless a failing test proves the direct unbound payload cannot pass through the existing boundary.

### Task 1: Add failing tests for direct unbound dispatch

**Files:**
- Modify: `tests/conversation-lifecycle-structure.test.ts` imports and unbound routing tests near lines 639-754

- [ ] **Step 1: Import the service factory and the new route symbol expected by the design.**

Add the service import alongside the existing conversation imports:

```ts
import {
  createHiveServices,
  routeUnboundConversation
} from "../lib/hive-services"
```

The import is intentionally written before implementation so the test fails for the missing direct route instead of silently testing a copied implementation.

- [ ] **Step 2: Add a failing Codex direct-dispatch test.**

Add this test after the existing unbound conversation tests. It must use the real `createHiveServices` route, make manager/project lookups fail if called, and capture the invocation sent to the agent:

```ts
test("unbound Codex dispatches directly without project binding or manager routing", { concurrency: false }, async (t) => {
  const { repository } = await repositoryFixture(t)
  const invocations: AgentInvocationInput[] = []

  const services = createHiveServices({
    repository,
    listProjects: async () => { throw new Error("unbound route must not list projects") },
    listWorkflowRuns: async () => { throw new Error("unbound route must not list workflow runs") },
    invokeAgent: async (input) => {
      invocations.push(input)
      return { status: "completed", source: "simulated", body: "ingestion complete" }
    }
  })

  const result = await services.conversation.postUnboundMessage({
    conversationId: "conversation:direct-codex",
    targetAgent: "codex",
    content: "Run yt-dlp, transcribe with whispercpp, and write the raw artifact.",
    idempotencyKey: "unbound-direct-codex-1"
  })

  assert.equal(result.status, "completed")
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].executor, "codex")
  assert.equal(invocations[0].conversationId, "conversation:direct-codex")
  assert.equal(invocations[0].skill.id, "conversation.unbound")
  assert.doesNotMatch(JSON.stringify(invocations[0].skill), /unbound_limited|read-only|Do not invoke external/i)
  assert.match(JSON.stringify(invocations[0].conversationHistory), /yt-dlp/)
})
```

Add `AgentInvocationInput` to the existing type import from `../lib/agent-bridge` rather than duplicating its shape:

```ts
import type { AgentInvocationInput } from "../lib/agent-bridge"
```

- [ ] **Step 3: Update the OpenClaw boundary test to call the real route helper.**

Replace the locally constructed `routeSkill` and `routeUnbound` callback in the existing test with the exported route helper. Capture the `WorkflowEventSkill` passed to `invokeAgent` and assert the actual payload has:

```ts
assert.equal(captured.skill.id, "conversation.unbound")
assert.equal(captured.skill.allowedActors[0], "openclaw.gengar")
assert.doesNotMatch(JSON.stringify(captured.skill), /unbound_limited|read-only|external systems/i)
```

The test must continue asserting the existing per-conversation/per-agent bridge identity mapping, so direct dispatch cannot regress session continuity.

- [ ] **Step 4: Add explicit delivery-cursor regression coverage.**

Exercise `routeUnboundConversation` twice with the same `ConversationHistorySync`: the first invocation returns `failed`, the second returns `completed`. Assert that the failed result does not cause the next invocation to omit the failed message, while the successful result advances the cursor. Use the existing `conversation-lifecycle-structure.test.ts` history helpers and keep the assertion focused on the `conversationHistory` passed to `invokeAgent`.

- [ ] **Step 5: Run the focused test compilation and verify RED.**

Run from `repos/jormungand`:

```powershell
npm test
```

Expected result: FAIL because `routeUnboundConversation` is not exported and the current Codex route still invokes the project-binding manager or emits `conversation.unbound_limited`. Do not change production code before observing this expected failure.

### Task 2: Implement one direct unbound route

**Files:**
- Modify: `lib/hive-services.ts:1-13, 193-261, 272-342`

- [ ] **Step 1: Remove only the manager-routing import and branch dependencies.**

Remove `parseUnboundManagerDecision` from the conversation import. Keep `invokeConfiguredHiveManager`, `listProjects`, and `listWorkflowRuns` in the module if their types or manager scheduler wiring still require them; remove only the runtime locals that existed solely for the deleted Codex unbound branch.

- [ ] **Step 2: Add the non-restrictive unbound skill factory.**

Define this helper immediately before the route function:

```ts
function createUnboundExecutionSkill(targetAgent: AgentKind): WorkflowEventSkill {
  return {
    id: "conversation.unbound",
    eventType: "requirement_intake",
    stage: "intake",
    name: "Unbound agent execution",
    purpose: "Execute the operator request directly without requiring project or workflow binding.",
    trigger: "The operator posted to an unbound conversation.",
    allowedActors: [targetAgent],
    inputs: ["recent conversation text", "agent style guidance"],
    outputs: ["agent response and requested execution results"],
    constraints: ["Report execution results and side effects accurately."],
    gates: ["Server authentication and bridge authorization remain required."],
    knowledgeSources: ["persisted unbound conversation"],
    verificationRules: ["Return the agent response and preserve the conversation identity."]
  }
}
```

The helper must not contain project-binding, manager-routing, external-action, irreversible-action, or read-only prohibitions.

- [ ] **Step 3: Rename the route helper to represent both agent families.**

Rename `routeOpenClawUnboundConversation` to `routeUnboundConversation` without changing its `ConversationHistorySync` algorithm. Keep the synthetic `createWorkflowRun` envelope with an empty repository and the existing `unbound:<agent>:<conversation>` sync key.

- [ ] **Step 4: Replace the helper payload with the full-execution skill.**

Change only the invocation metadata in the route helper:

```ts
const result = await input.invokeAgent({
  run: syntheticRun,
  executor: input.targetAgent,
  stage: "intake",
  artifactType: "log",
  title: "Unbound agent execution",
  fallbackBody: "Execute the operator request and return the result.",
  conversationId: input.conversationId,
  conversationHistory: delta.history,
  skill: createUnboundExecutionSkill(input.targetAgent)
})
```

Leave the existing success-only `markDelivered` call and returned status mapping unchanged.

- [ ] **Step 5: Route every unbound target through the helper.**

Replace the `if (targetAgent === "codex")` manager-routing block with:

```ts
routeUnbound: ({ conversationId, targetAgent, content, entries }) =>
  routeUnboundConversation({
    sync: openClawUnboundConversationSync,
    conversationId,
    targetAgent,
    content,
    entries,
    invokeAgent
  })
```

This removes the project lookup, JSON manager response, `parseUnboundManagerDecision`, and implicit binding path from unbound messages while leaving the manager scheduler used by bound workflow runs intact.

- [ ] **Step 6: Run the direct tests and verify GREEN.**

Run:

```powershell
npm test
```

Expected result: the new direct-dispatch tests and all existing tests pass. If an existing manager-scheduler fixture fails because of an accidentally removed option/type, restore that compatibility surface without reintroducing manager routing into `routeUnbound`.

### Task 3: Document the new operator-facing behavior

**Files:**
- Modify: `README.md` near the existing `JORMUNGAND_AGENT_PERMISSION_MODE` section

- [ ] **Step 1: Add a concise Unbound execution section.**

Add this behavior description after the permission-mode paragraph:

```markdown
Unbound conversations dispatch directly to the selected Codex or OpenClaw
agent and do not require a project or workflow binding. They may perform the
requested external commands and write artifacts when the configured bridge
runtime has those capabilities. Server-side authentication, bridge tokens,
conversation audit, and `JORMUNGAND_AGENT_PERMISSION_MODE` still apply;
frontend validation is not an authorization boundary.
```

- [ ] **Step 2: Check the documentation diff.**

Run:

```powershell
git diff --check -- README.md lib/hive-services.ts tests/conversation-lifecycle-structure.test.ts
```

Expected result: no whitespace errors.

### Task 4: Run the complete verification gate

**Files:**
- Verify only: all files changed by Tasks 1-3

- [ ] **Step 1: Run lint.**

```powershell
npm run lint
```

Expected result: exit code 0 with no new lint errors.

- [ ] **Step 2: Run typecheck.**

```powershell
npm run typecheck
```

Expected result: exit code 0. If the repository has a pre-existing unrelated failure, record the exact file and error in the final report; do not broaden this change.

- [ ] **Step 3: Run the full test suite.**

```powershell
npm test
```

Expected result: all compiled Node tests pass, including direct Codex/OpenClaw unbound dispatch, history cursor behavior, and bound workflow regression coverage.

- [ ] **Step 4: Run the production build.**

```powershell
npm run build
```

Expected result: Next.js build completes successfully.

- [ ] **Step 5: Review the final diff and working-tree safety.**

```powershell
git diff --check
git status --short
git diff --stat -- README.md lib/hive-services.ts tests/conversation-lifecycle-structure.test.ts docs/superpowers/specs/2026-08-20-unbound-full-agent-execution-design.md docs/superpowers/plans/2026-08-20-unbound-full-agent-execution.md
```

Confirm that unrelated pre-existing changes remain unstaged and untouched.

- [ ] **Step 6: Commit only the implementation files.**

```powershell
git add -- README.md lib/hive-services.ts tests/conversation-lifecycle-structure.test.ts
git commit -m "Allow direct execution from unbound conversations" -m "Route unbound Codex and OpenClaw messages directly to the selected agent while preserving conversation history, bridge authentication, audit, and bound workflow behavior." -m "Constraint: The single-user ingestion workflow requires external commands and artifact writes without project binding." -m "Rejected: Frontend-only authorization | client-side validation cannot protect server-side bridge APIs" -m "Confidence: high" -m "Scope-risk: broad" -m "Reversibility: clean" -m "Directive: Keep server-side authentication, bridge tokens, and audit when changing unbound execution behavior." -m "Tested: lint, typecheck, full test suite, and production build" -m "Not-tested: Remote OpenClaw container privileges outside Jormungand's bridge contract"
```

## Plan self-review

- Spec coverage: direct dispatch, removal of the limited skill, removal of the Codex manager detour, history cursor semantics, authentication/audit preservation, tests, and deployment limits are covered by Tasks 1-4.
- Completeness scan: no incomplete marker or vague implementation step remains.
- Type consistency: the plan uses `routeUnboundConversation`, `createUnboundExecutionSkill`, `AgentInvocationInput`, `AgentArtifactResult`, `WorkflowEventSkill`, and existing `createHiveServices` option names consistently.
- Scope check: only the unbound conversation route, its regression tests, and operator documentation change; bound workflow routing and bridge auth remain outside the change.
