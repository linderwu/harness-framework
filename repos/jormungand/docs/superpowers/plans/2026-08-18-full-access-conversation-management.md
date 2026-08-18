# Full-access Agent Execution and Conversation Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox list syntax for tracking.

**Goal:** Add durable unbound conversation management, make the configured agent runtime full-access by default, and apply the approved Layered press interaction to the conversation controls.

**Architecture:** Keep conversation_entries and codex_sessions as the message/session sources of truth, and add a small conversations metadata table plus a management service for title and lifecycle operations. Centralize the full/restricted permission decision in a typed server helper, mirror that decision in the Node bridge, and make workflow/manager approval behavior follow the same mode. Extend the existing TaskConversation component and CSS in place so existing project-bound workflow conversations retain their current identity semantics.

**Tech Stack:** Next.js 16 route handlers, React 18, TypeScript, better-sqlite3, Node test runner, ESLint, and the existing Codex/OpenClaw bridge scripts.

---

## Working-tree safety

The checkout is already dirty. Existing changes in app/api/conversation/route.ts, components/task-conversation.tsx, lib/hive-memory/repository.ts, tests/ouroboros-layout.test.ts, and the parent .omx/artifact paths belong to the user. Do not reset, clean, or reformat them. Before each task, inspect the current diff for files that task will touch and layer the implementation on top of the existing conversation-lifecycle work.

The design spec is already committed as fb46f56 at docs/superpowers/specs/2026-08-18-full-access-conversation-management-design.md.

## File map

Create:

- lib/agent-permissions.ts — typed permission-mode parsing and shared server-side predicates.
- lib/conversation-management.ts — title/lifecycle validation and delete/stop orchestration used by routes.
- app/api/conversations/[id]/route.ts — PATCH and DELETE handlers for one unbound conversation.
- tests/agent-permissions.test.ts — full/restricted mode contract tests.
- tests/conversation-management.test.ts — repository/service/API lifecycle tests.

Modify:

- .env.example, README.md — document JORMUNGAND_AGENT_PERMISSION_MODE and its full-access effect.
- lib/hive-memory/types.ts — conversation state and summary types.
- lib/hive-memory/schema.ts — schema version 3 and the metadata-table migration/backfill.
- lib/hive-memory/repository.ts — metadata CRUD, summary queries, activity checks, and cleanup.
- lib/codex-conversation.ts — expose a safe session-stop helper for deletion.
- app/api/conversations/route.ts — list and create metadata records.
- app/api/conversation/new/route.ts — delegate creation to the metadata service while preserving the cookie response.
- app/api/conversation/route.ts — return the active permission mode and title metadata where the existing client hydrates state.
- lib/agent-bridge.ts — include the effective permission mode in bridge requests.
- scripts/codex-bridge.mjs — full/restricted command-line and app-server policies.
- scripts/openclaw-bridge.mjs — carry the permission mode through the OpenClaw envelope and make the mode explicit to the external runtime.
- lib/context-builder.ts, lib/hive-services.ts, scripts/codex-bridge.mjs — remove restricted-only prompt language in full mode while preserving the restricted prompt.
- lib/workflow.ts — bypass approval-gate pauses and advance stages directly in full mode.
- lib/managed-workflows.ts, lib/manager-scheduler.ts, lib/hive-manager.ts — prevent full mode from turning manager effects into pending approvals while retaining audit records.
- components/task-conversation.tsx — title/list state and rename/archive/delete controls.
- app/globals.css — Layered press states and responsive manager layout.
- existing conversation, bridge, workflow, and UI tests — extend the contracts without weakening old restricted-mode assertions.

---

### Task 0: Establish a clean implementation baseline

**Files:**
- Read: AGENTS.md, node_modules/next/dist/docs/index.md, package.json
- Inspect: app/api/conversation/route.ts, components/task-conversation.tsx, lib/hive-memory/repository.ts, scripts/codex-bridge.mjs, lib/workflow.ts

- [ ] **Step 1: Read the Next.js agent guide before editing route handlers**

Run:

~~~powershell
Get-Content -Raw node_modules/next/dist/docs/index.md
~~~

Confirm the plan uses the installed Next 16 route-handler parameter shape, where existing dynamic routes receive context.params as a promise.

- [ ] **Step 2: Capture the scoped baseline without touching unrelated files**

Run:

~~~powershell
git diff -- app/api/conversation/route.ts components/task-conversation.tsx lib/hive-memory/repository.ts
npm test
~~~

Expected: the current test command completes with the pre-existing working-tree behavior, or its failures are recorded before implementation. Do not fix unrelated failures in this task.

- [ ] **Step 3: Commit no code in this task**

Use the baseline output as the comparison point for later tasks. Keep the user’s existing dirty files untouched unless a later task explicitly lists them.

---

### Task 1: Add the shared permission-mode contract

**Files:**
- Create: lib/agent-permissions.ts
- Create: tests/agent-permissions.test.ts
- Modify: .env.example, README.md

- [ ] **Step 1: Write failing tests for mode parsing and predicates**

Create tests with these exact expectations:

~~~ts
test("permission mode defaults to full", () => {
  assert.equal(getAgentPermissionMode(undefined), "full")
  assert.equal(isFullAgentPermissionMode("full"), true)
})

test("only restricted opts back into the restricted runtime", () => {
  assert.equal(getAgentPermissionMode("restricted"), "restricted")
  assert.equal(getAgentPermissionMode("unknown"), "full")
  assert.equal(isFullAgentPermissionMode("restricted"), false)
})
~~~

The test must import the helper from lib/agent-permissions.ts and must not mutate the process environment.

- [ ] **Step 2: Run the focused test and verify it fails**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/agent-permissions.test.js
~~~

Expected: FAIL because the helper module does not exist yet.

- [ ] **Step 3: Implement the minimal typed helper**

Implement this public contract:

~~~ts
export type AgentPermissionMode = "full" | "restricted"

export function getAgentPermissionMode(
  value = process.env.JORMUNGAND_AGENT_PERMISSION_MODE
): AgentPermissionMode {
  return value?.trim().toLowerCase() === "restricted" ? "restricted" : "full"
}

export function isFullAgentPermissionMode(
  value = process.env.JORMUNGAND_AGENT_PERMISSION_MODE
) {
  return getAgentPermissionMode(value) === "full"
}
~~~

Document the default and opt-back in under .env.example and README.md:

~~~text
JORMUNGAND_AGENT_PERMISSION_MODE=full
~~~

State clearly that full disables the agent sandbox and workflow approval pauses, while the site Basic Auth boundary remains enabled.

- [ ] **Step 4: Run the focused test and typecheck**

Run the commands from Step 2 again. Expected: both pass.

- [ ] **Step 5: Commit the permission contract**

~~~powershell
git add lib/agent-permissions.ts tests/agent-permissions.test.ts .env.example README.md
git commit -m "feat: add explicit agent permission mode"
~~~

---

### Task 2: Apply full permissions at the bridge boundary

**Files:**
- Modify: scripts/codex-bridge.mjs
- Modify: scripts/openclaw-bridge.mjs
- Modify: lib/agent-bridge.ts
- Modify: tests/bridge-security.test.ts, tests/codex-conversation-structure.test.ts, tests/agent-bridge-profile.test.ts

- [ ] **Step 1: Add failing source-contract assertions**

Extend the bridge tests to require all of these contracts:

~~~ts
assert.match(codexBridgeSource, /dangerously-bypass-approvals-and-sandbox/)
assert.match(codexBridgeSource, /danger-full-access/)
assert.match(codexBridgeSource, /dangerFullAccess/)
assert.match(codexBridgeSource, /approvalPolicy: "never"/)
assert.match(agentBridgeSource, /permissionMode/)
~~~

Also add a restricted-mode test that asserts the existing workspace-write, writableRoots, and networkAccess: false path remains present.

- [ ] **Step 2: Run the focused bridge tests and verify the new assertions fail**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/bridge-security.test.js .tmp-tests/tests/codex-conversation-structure.test.js .tmp-tests/tests/agent-bridge-profile.test.js
~~~

Expected: the new full-access assertions fail against the current workspace-write/network-disabled bridge.

- [ ] **Step 3: Implement the full/restricted exec argument split**

In scripts/codex-bridge.mjs, normalize the environment once:

~~~js
const permissionMode =
  process.env.JORMUNGAND_AGENT_PERMISSION_MODE?.trim().toLowerCase() === "restricted"
    ? "restricted"
    : "full"
~~~

For runCodex, build args so full mode includes --dangerously-bypass-approvals-and-sandbox and does not include --sandbox; restricted mode keeps --sandbox with CODEX_BRIDGE_SANDBOX ?? "workspace-write". Keep -C, --skip-git-repo-check, output-file handling, timeout, cancellation, and idempotency unchanged.

For app-server sessions, use these exact policy shapes:

~~~js
const fullThreadPolicy = {
  sandbox: "danger-full-access",
  approvalPolicy: "never"
}
const restrictedThreadPolicy = {
  sandbox: "workspace-write",
  approvalPolicy: "never"
}

const fullTurnPolicy = {
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
  cwd: session.workspacePath
}
~~~

Select the full policy in full mode and the current writable-root/network-disabled policy in restricted mode. Do not leave networkAccess: false on the full branch.

- [ ] **Step 4: Carry the mode through configured-agent requests**

Add permissionMode: getAgentPermissionMode() to the JSON body in lib/agent-bridge.ts. Include it in the OpenClaw envelope body in scripts/openclaw-bridge.mjs so the external bridge can make the runtime mode explicit. Do not claim that Jormungand can change Docker capabilities after the OpenClaw container has already been started; the bridge contract must report the requested mode and the deployment must provide matching container privileges.

- [ ] **Step 5: Run focused bridge tests and commit**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/bridge-security.test.js .tmp-tests/tests/codex-conversation-structure.test.js .tmp-tests/tests/agent-bridge-profile.test.js
git add scripts/codex-bridge.mjs scripts/openclaw-bridge.mjs lib/agent-bridge.ts tests/bridge-security.test.ts tests/codex-conversation-structure.test.ts tests/agent-bridge-profile.test.ts
git commit -m "feat: run agents with full bridge permissions"
~~~

Expected: full and restricted source contracts pass, and the captured bridge payload contains permissionMode.

---

### Task 3: Make workflow and manager approval behavior follow the mode

**Files:**
- Modify: lib/workflow.ts, lib/managed-workflows.ts, lib/manager-scheduler.ts, lib/hive-manager.ts
- Modify: lib/context-builder.ts, lib/hive-services.ts, scripts/codex-bridge.mjs
- Modify: tests/workflow.test.ts, tests/managed-workflows.test.ts, tests/hive-manager.test.ts, tests/hive-mission-e2e.test.ts, tests/context-builder.test.ts, tests/bridge-security.test.ts

- [ ] **Step 1: Add failing full-mode tests while preserving restricted tests**

Add tests that pass the mode explicitly where the API allows it, and use a scoped environment override only for prompt/route integration tests. Required expectations:

~~~ts
assert.equal(requiresHumanApproval("protected_push", "full"), false)
assert.equal(requiresHumanApproval("protected_push", "restricted"), true)

const fullRun = await advanceWorkflow(run, {
  ...options,
  permissionMode: "full"
})
assert.equal(fullRun.approvalGates.length, 0)
assert.notEqual(fullRun.status, "waiting_for_approval")
~~~

Add a manager scheduler assertion that a request_approval action is recorded in the checkpoint but does not invoke requestApproval or set the run to waiting_for_approval in full mode. Keep the existing restricted-mode expectation unchanged.

- [ ] **Step 2: Run the focused workflow tests and verify failure**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/workflow.test.js .tmp-tests/tests/managed-workflows.test.js .tmp-tests/tests/hive-manager.test.js .tmp-tests/tests/hive-mission-e2e.test.js
~~~

Expected: the new full-mode assertions fail because the current engine always creates approval gates and the manager always waits after request_approval.

- [ ] **Step 3: Thread permissionMode through workflow and manager decisions**

Use AgentPermissionMode from lib/agent-permissions.ts in AdvanceWorkflowOptions and manager scheduler dependencies. Default omitted values through getAgentPermissionMode() so production uses full mode while tests can select restricted mode without process-global leakage.

For the normal workflow path, replace only the approval pause points:

~~~text
plan review complete + full       -> currentStage = design, status = pending
design artifact complete + full   -> currentStage = implementation, status = pending
verification complete + full      -> currentStage = completed, status = completed, closeout event
restricted                        -> existing openApprovalGate path
~~~

Keep revision creation, blocking-finding behavior, artifact writes, event logging, and restricted approval decisions unchanged. Ensure no full-mode path calls openApprovalGate.

In lib/managed-workflows.ts, make requiresHumanApproval(effect, mode) return false only for full mode. In lib/manager-scheduler.ts, skip the requestApproval callback and waitingForApproval = true assignment in full mode, but retain the action in appliedActions and the checkpoint for auditability. In lib/hive-manager.ts, keep request parsing and scope validation; do not remove the action from the audit contract.

- [ ] **Step 4: Update context and manager prompts**

In full mode, replace restricted-only text such as task-scoped only, external or irreversible effects without approval, current sandbox, and Never raise permissions with a statement that the runtime has full permissions and that the operator’s requested scope is authoritative. Keep the memory-as-evidence warning and workflow identity checks.

In restricted mode, preserve the existing safety text exactly enough for current security tests to continue passing.

- [ ] **Step 5: Run focused tests and commit**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/workflow.test.js .tmp-tests/tests/managed-workflows.test.js .tmp-tests/tests/hive-manager.test.js .tmp-tests/tests/hive-mission-e2e.test.js .tmp-tests/tests/context-builder.test.js .tmp-tests/tests/bridge-security.test.js
git add lib/workflow.ts lib/managed-workflows.ts lib/manager-scheduler.ts lib/hive-manager.ts lib/context-builder.ts lib/hive-services.ts scripts/codex-bridge.mjs tests/workflow.test.ts tests/managed-workflows.test.ts tests/hive-manager.test.ts tests/hive-mission-e2e.test.ts tests/context-builder.test.ts tests/bridge-security.test.ts
git commit -m "feat: bypass workflow approvals in full mode"
~~~

Expected: both explicit modes pass; only full mode bypasses approval pauses.

---

### Task 4: Add the conversation metadata migration and repository operations

**Files:**
- Modify: lib/hive-memory/types.ts, lib/hive-memory/schema.ts, lib/hive-memory/repository.ts
- Modify: tests/hive-memory-database.test.ts, tests/hive-memory-repository.test.ts
- Create: tests/conversation-management.test.ts

- [ ] **Step 1: Add failing database/repository tests**

Add tests that assert:

~~~ts
assert.equal(database.schemaVersion(), 3)
assert.equal(repository.createConversation({ id: "conversation:a", title: "A" }).state, "active")
assert.equal(repository.renameConversation("conversation:a", "Renamed").title, "Renamed")
assert.equal(repository.setConversationState("conversation:a", "archived").state, "archived")
assert.equal(repository.setConversationState("conversation:a", "active").archivedAt, undefined)
~~~

Insert a legacy conversation_entries row before opening the v3 database and assert that listing summaries returns a generated title and correct message count. Insert a running codex_sessions row and assert that the repository reports the conversation as busy. Assert that delete removes metadata, entries, and session only after the service has stopped the session.

- [ ] **Step 2: Run the focused tests and verify failure**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/hive-memory-database.test.js .tmp-tests/tests/hive-memory-repository.test.js .tmp-tests/tests/conversation-management.test.js
~~~

Expected: schema version remains 2 and the new repository methods are missing.

- [ ] **Step 3: Add v3 types and migration**

Add:

~~~ts
export type ConversationState = "active" | "archived"

export interface ConversationMetadata {
  conversationId: string
  title: string
  state: ConversationState
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

export interface ConversationSummary {
  conversationId: string
  title: string
  state: ConversationState
  messageCount: number
  latestMessageAt?: string
  latestMessage?: string
}
~~~

Set hiveSchemaVersion = 3. Add the conversations table with a state check, archived_at, timestamps, and an index on (state, updated_at). Backfill one row per existing conversation:* identity plus legacyConversationId using INSERT OR IGNORE; use the first user message as the title source and New conversation when no user message exists. Keep the migration transactionally isolated and idempotent.

- [ ] **Step 4: Implement repository metadata methods**

Add focused methods with these signatures:

~~~ts
createConversation(input: { id: string; title: string }): Promise<ConversationMetadata>
getConversationMetadata(id: string): ConversationMetadata | undefined
listConversationSummaries(input?: { includeArchived?: boolean }): ConversationSummary[]
renameConversation(id: string, title: string): Promise<ConversationMetadata>
setConversationState(id: string, state: ConversationState): Promise<ConversationMetadata>
isConversationRunning(id: string): boolean
deleteConversation(id: string): Promise<void>
~~~

Update insertConversation to INSERT OR IGNORE metadata for a new unbound identity and refresh updated_at whenever a message is inserted or updated. deleteConversation must run a single SQLite transaction deleting codex_sessions, conversation_entries, and conversations for the requested unbound identity. Reject non-conversation:* and legacy bound identities in this method so project-bound workflow data cannot be deleted through the unbound manager.

- [ ] **Step 5: Run repository tests and commit**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/hive-memory-database.test.js .tmp-tests/tests/hive-memory-repository.test.js .tmp-tests/tests/conversation-management.test.js
git add lib/hive-memory/types.ts lib/hive-memory/schema.ts lib/hive-memory/repository.ts tests/hive-memory-database.test.ts tests/hive-memory-repository.test.ts tests/conversation-management.test.ts
git commit -m "feat: persist conversation metadata"
~~~

Expected: schema version 3, migration backfill, metadata CRUD, summary queries, and transactional cleanup all pass.

---

### Task 5: Add the conversation management service and API routes

**Files:**
- Create: lib/conversation-management.ts, app/api/conversations/[id]/route.ts
- Modify: app/api/conversations/route.ts, app/api/conversation/new/route.ts, app/api/conversation/route.ts, lib/codex-conversation.ts
- Modify: tests/conversation-management.test.ts, tests/conversation-lifecycle-structure.test.ts

- [ ] **Step 1: Add failing service and route tests**

Cover these exact cases:

~~~text
POST /api/conversations                         -> 201 + cookie + active metadata
GET /api/conversations                         -> active summaries only
GET /api/conversations?includeArchived=true    -> active + archived
PATCH /api/conversations/:id {title}           -> renamed summary
PATCH /api/conversations/:id {state}           -> archived/unarchived summary
PATCH running conversation                     -> 409
DELETE without {confirm:true}                  -> 400
DELETE running conversation                    -> 409
DELETE confirmed conversation                  -> 204 and no rows remain
~~~

Use the existing isolated data-directory route helper and fake bridge fetch from tests/conversation-lifecycle-structure.test.ts. Assert that a failed bridge stop leaves all rows intact.

- [ ] **Step 2: Run the focused route tests and verify failure**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-management.test.js .tmp-tests/tests/conversation-lifecycle-structure.test.js
~~~

Expected: the list route lacks POST behavior, the dynamic route is absent, and deletion/rename operations are unavailable.

- [ ] **Step 3: Implement the management service**

Use a service dependency boundary so routes do not know how to stop a bridge:

~~~ts
export interface ConversationManagementDependencies {
  repository: HiveMemoryRepository
  stopSession: (conversationId: string) => Promise<void>
}
~~~

Validate IDs as unbound conversation identities, trim titles to 80 characters, return stable 400/404/409 errors, and perform this delete sequence:

~~~text
validate confirm
load metadata
if running -> 409
if Codex session exists -> stopSession()
repository.deleteConversation()
~~~

If stopSession rejects, do not call repository deletion.

- [ ] **Step 4: Implement route handlers using the installed Next.js shape**

Use context: { params: Promise<{ id: string }> } in [id]/route.ts. Keep route responses JSON except successful DELETE, which returns 204. POST /api/conversations creates an ID through createConversationId, persists metadata, and uses setConversationCookie. Make /api/conversation/new delegate to the same service so the existing client route remains compatible.

Add permissionMode and current metadata to GET /api/conversation so the existing hydration path can render the capability badge without a second permission endpoint.

- [ ] **Step 5: Run route tests and commit**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-management.test.js .tmp-tests/tests/conversation-lifecycle-structure.test.js
git add lib/conversation-management.ts lib/codex-conversation.ts app/api/conversations app/api/conversation/new/route.ts app/api/conversation/route.ts tests/conversation-management.test.ts tests/conversation-lifecycle-structure.test.ts
git commit -m "feat: add conversation management API"
~~~

---

### Task 6: Add conversation manager behavior to TaskConversation

**Files:**
- Modify: components/task-conversation.tsx
- Modify: tests/conversation-ui-structure.test.ts, tests/conversation-ui-behavior.test.ts

- [ ] **Step 1: Add failing UI contract tests**

Assert that the component source and static render contain:

~~~text
conversation title
Rename conversation
Archive conversation
Unarchive conversation
Delete conversation
includeArchived=true
confirm: true
Full access
~~~

Add behavior coverage that mocks fetch and verifies rename, archive, and delete calls use the correct route/method/body. Verify a delete failure preserves the current entries and a new conversation invalidates stale polling as the existing tests already require.

- [ ] **Step 2: Run the focused UI tests and verify failure**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/conversation-ui-behavior.test.js
~~~

Expected: current UI exposes only a raw select and New conversation; management actions and permission mode are absent.

- [ ] **Step 3: Extend the client state with typed summaries and mutation state**

Add a local summary type matching the API and state for:

~~~ts
const [includeArchived, setIncludeArchived] = useState(false)
const [conversationMutation, setConversationMutation] =
  useState<"rename" | "archive" | "delete" | undefined>()
const [permissionMode, setPermissionMode] =
  useState<AgentPermissionMode>("full")
~~~

Refresh summaries after create, send, rename, archive/unarchive, and delete. On delete of the active conversation, create/select a fresh conversation and reset entries/session/events before the next poll can write stale state. Keep requestGeneration invalidation in place.

- [ ] **Step 4: Render the manager controls accessibly**

Keep the existing New conversation button identifiable by aria-label. Add:

- a title in the header with truncation;
- an active/archived filter or toggle;
- a per-conversation action menu with visible text labels;
- a rename form constrained to 1–80 characters;
- archive/unarchive action;
- delete confirmation using the native dialog when available, with an inline fallback for test/static render;
- a Full access status badge near the existing Codex session status.

Disable conflicting actions while loading, a mutation is pending, or the Codex turn is active. Keep the agent selector and composer behavior unchanged for bound runs.

- [ ] **Step 5: Run UI tests and commit**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/conversation-ui-behavior.test.js
git add components/task-conversation.tsx tests/conversation-ui-structure.test.ts tests/conversation-ui-behavior.test.ts
git commit -m "feat: manage conversations from the conversation panel"
~~~

---

### Task 7: Apply Layered press styling and responsive manager layout

**Files:**
- Modify: app/globals.css
- Modify: tests/layout-css.test.ts, tests/conversation-ui-structure.test.ts

- [ ] **Step 1: Add failing CSS contract assertions**

Require the conversation button rules to contain:

~~~ts
assert.match(globalsCss, /\.primaryButton[\s\S]*box-shadow: 0 4px 0/)
assert.match(globalsCss, /\.primaryButton:active[\s\S]*transform: translateY\(3px\)/)
assert.match(globalsCss, /prefers-reduced-motion: reduce/)
assert.match(globalsCss, /taskConversationHeaderActions[\s\S]*flex-wrap: wrap/)
~~~

Add a responsive assertion that manager title/action containers use min-width: 0 and do not introduce fixed button widths.

- [ ] **Step 2: Run the focused CSS tests and verify failure**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/layout-css.test.js .tmp-tests/tests/conversation-ui-structure.test.js
~~~

Expected: current primary/compact buttons have no Layered press depth and no conversation manager rules.

- [ ] **Step 3: Implement the tactile button states**

Use the existing color tokens and add one depth token rather than introducing a new component system:

~~~css
.primaryButton,
.compactPanelButton,
.dangerButton {
  --button-depth: #0b6659;
  box-shadow: 0 4px 0 var(--button-depth);
  transform: translateY(0);
  transition: background 160ms ease, box-shadow 120ms ease, transform 120ms ease;
}

.primaryButton:active,
.compactPanelButton:active,
.dangerButton:active {
  box-shadow: 0 1px 0 var(--button-depth);
  transform: translateY(3px);
}
~~~

Use a danger-specific depth token, add focus-visible rings, remove the depth on disabled controls, and add a reduced-motion rule that removes transitions. Do not combine a wide soft shadow with a decorative border on these controls.

- [ ] **Step 4: Add responsive manager rules**

Keep the desktop header as a wrapping flex row. On narrow widths, stack the title and actions, set manager text containers to min-width: 0, let action groups wrap, and preserve the existing mobile composer one-column rule. Verify 320px and 375px widths have no horizontal overflow.

- [ ] **Step 5: Run CSS tests and commit**

~~~powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/layout-css.test.js .tmp-tests/tests/conversation-ui-structure.test.js
git add app/globals.css tests/layout-css.test.ts tests/conversation-ui-structure.test.ts
git commit -m "feat: add layered press conversation controls"
~~~

---

### Task 8: Run full verification and browser checks

**Files:**
- Inspect: all files changed by Tasks 1–7
- Modify only if a verifier identifies a regression: the smallest affected file and its test

- [ ] **Step 1: Run the complete test suite**

~~~powershell
npm test
~~~

Expected: all existing restricted-mode safety tests and all new full-mode, migration, API, and UI tests pass.

- [ ] **Step 2: Run static checks and production build**

~~~powershell
npm run typecheck
npm run lint
npm run build
~~~

Expected: TypeScript, ESLint, and Next.js production build complete successfully. If a check fails, add or adjust only the regression test and implementation that caused it, then rerun the failed check before proceeding.

- [ ] **Step 3: Start the app with full mode and verify runtime behavior**

Set the task-scoped environment for the local process:

~~~powershell
$env:JORMUNGAND_AGENT_PERMISSION_MODE = "full"
npm run dev
~~~

Verify in the browser:

1. The conversation header displays Full access.
2. New conversation creates a durable titled entry.
3. Rename persists after refresh.
4. Archive removes the item from the active list and includeArchived=true restores it.
5. Delete requires confirmation and removes the conversation after stopping an idle/running session.
6. The send/new/action buttons visibly depress and return to their resting depth.
7. At desktop and 320px/375px viewport widths, the manager wraps without horizontal scrolling.

- [ ] **Step 4: Inspect the final diff for scope and unrelated changes**

~~~powershell
git diff --check
git status --short --untracked-files=no
git diff --stat HEAD~7..HEAD
~~~

Confirm every changed line belongs to the approved design or a verifier failure. Do not stage or remove the existing unrelated .omx, AMR artifact, or user-owned worktree changes.

- [ ] **Step 5: Commit only a verified regression fix, if one was required**

If a verifier identified a regression, stage only the exact file paths named by that failure, rerun the failed check, and commit with:

~~~powershell
git commit -m "fix: address full access conversation verification"
~~~

Do not create a broad cleanup commit.

## Plan self-review

Spec coverage:

- Full local permission, network access, no workflow approval pause, and visible mode: Tasks 1–3 and 6.
- Durable conversation table, migration, title, lifecycle, cleanup, and busy-session conflicts: Tasks 4–5.
- Create/switch/rename/archive/unarchive/delete API and UI: Tasks 5–6.
- Layered press, focus, disabled, reduced motion, and responsive behavior: Task 7.
- Audit preservation and complete verification: Tasks 2–3 and 8.

No step depends on an undefined function name: getAgentPermissionMode, AgentPermissionMode, ConversationSummary, ConversationManagementDependencies, and all repository method names are introduced before their first use. The plan keeps full mode and restricted mode explicit so existing safety tests remain meaningful. There are no placeholder steps or unassigned files.
