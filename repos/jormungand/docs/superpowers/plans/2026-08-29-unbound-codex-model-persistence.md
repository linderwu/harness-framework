# Unbound Codex Model Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the selected Codex model for each unbound conversation and use it for the next Arceus execution after reload.

**Architecture:** Extend the existing SQLite-backed `conversations` metadata with a nullable `selected_model_id`. Expose the value through the existing unbound conversation GET response and add a narrow metadata update operation; the existing synthetic unbound run then carries the saved model into the bridge payload. Only the existing selector's data binding changes; no visual markup, labels, CSS, or layout changes.

**Tech Stack:** Next.js App Router, TypeScript, better-sqlite3, Node test runner, existing Codex bridge model catalog.

---

### Task 1: Persist model metadata in the Hive repository

**Files:**
- Modify: `lib/hive-memory/types.ts`
- Modify: `lib/hive-memory/schema.ts`
- Modify: `lib/hive-memory/repository.ts`
- Test: `tests/hive-memory-database.test.ts`
- Test: `tests/conversation-management.test.ts`

- [ ] **Step 1: Write the failing repository test**

Create a conversation, assert its model is initially absent, call the new repository metadata update method with `gpt-5.6-sol`, read metadata again, and assert the value round-trips. Then clear it with `null` and assert it is absent again.

- [ ] **Step 2: Run the repository test and verify it fails**

Run:

```bash
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/hive-memory-database.test.js .tmp-tests/tests/conversation-management.test.js
```

Expected failure: `ConversationMetadata`/repository does not yet expose the selected model update behavior.

- [ ] **Step 3: Add the nullable schema migration**

Increase `hiveSchemaVersion` from `8` to `9`, add:

```sql
ALTER TABLE conversations ADD COLUMN selected_model_id TEXT;
```

and apply it through the existing `if (currentVersion < 9)` transactional migration pattern. Existing rows must remain valid with `NULL`.

- [ ] **Step 4: Add repository read/write support**

Add `selectedModelId?: string` to `ConversationMetadata`, add `selected_model_id` to `ConversationMetadataRow`, map it in `conversationMetadataFromRow`, and add:

```ts
async updateConversationModel(input: { id: string; selectedModelId?: string | null }): Promise<ConversationMetadata>
```

The method updates only `selected_model_id` and `updated_at`, preserves title/state, returns the refreshed metadata, and uses `NULL` for an empty/cleared value.

- [ ] **Step 5: Run the repository tests and commit**

Run the focused tests again and commit only the repository/schema/type/test files:

```bash
git add lib/hive-memory/types.ts lib/hive-memory/schema.ts lib/hive-memory/repository.ts tests/hive-memory-database.test.ts tests/conversation-management.test.ts
git commit -m "feat: persist conversation codex model"
```

### Task 2: Add the metadata API contract

**Files:**
- Modify: `lib/conversation-management.ts`
- Modify: `app/api/conversations/[id]/route.ts`
- Test: `tests/conversation-lifecycle-structure.test.ts`

- [ ] **Step 1: Write the failing API/service test**

Extend the existing managed conversation PATCH test to send `{ selectedModelId: "gpt-5.6-sol" }`, assert HTTP 200, and assert the returned metadata/repository value contains that model. Add a clear request with `selectedModelId: null` and assert the field is absent. Keep the existing title/state exclusivity tests unchanged.

- [ ] **Step 2: Run the API test and verify it fails**

Run:

```bash
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-lifecycle-structure.test.js
```

Expected failure: the management service currently accepts only `title` or `state`.

- [ ] **Step 3: Implement the narrow model update**

Allow `selectedModelId` as the third mutually exclusive PATCH operation. Validate it as either `null`/empty (clear) or a bounded non-empty string, call `repository.updateConversationModel`, and return metadata-shaped state without changing title/state behavior. The route must pass `body.selectedModelId` through and must continue rejecting requests that provide zero or multiple update fields.

- [ ] **Step 4: Run the API test and commit**

Run the focused test and commit only the service, route, and test files:

```bash
git add lib/conversation-management.ts app/api/conversations/[id]/route.ts tests/conversation-lifecycle-structure.test.ts
git commit -m "feat: expose conversation model settings"
```

### Task 3: Wire unbound state into the existing selector and dispatch

**Files:**
- Modify: `components/task-conversation.tsx`
- Modify: `components/harness-dashboard.tsx`
- Modify: `app/api/conversation/route.ts`
- Modify: `lib/conversation.ts`
- Modify: `lib/hive-services.ts`
- Test: `tests/conversation-ui-behavior.test.ts`
- Test: `tests/conversation-ui-structure.test.ts`
- Test: `tests/conversation.test.ts`

- [ ] **Step 1: Write the failing behavior tests**

Cover three behaviors:

1. Unbound GET exposes `metadata.selectedModelId` to the conversation component.
2. Selecting a non-default model for an unbound conversation invokes the metadata PATCH with the current conversation ID and selected model.
3. Unbound dispatch creates its synthetic run with the stored model, so the injected `invokeAgent` receives `run.selectedModelId === "gpt-5.6-sol"`.

The tests must assert data flow only; do not add or change visual snapshots, classes, labels, or layout expectations.

- [ ] **Step 2: Run the behavior tests and verify they fail**

Run:

```bash
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-ui-behavior.test.js .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/conversation.test.js
```

Expected failure: unbound conversation state and dispatch do not carry a selected model.

- [ ] **Step 3: Add the minimum state/API wiring**

Load `metadata.selectedModelId` from the unbound conversation response, keep it in the existing dashboard/task-conversation state, and invoke the metadata PATCH when the existing Codex selector changes. Preserve `MiniMax-M3` fallback when no value exists. Extend the unbound request/service input with the selected model, read the persisted metadata before routing, and pass it to `createWorkflowRun` as `selectedModelId`.

Do not alter the selector JSX structure, displayed options, classes, text, CSS, or layout. Only add the state and persistence callback required by the current control.

- [ ] **Step 4: Run the behavior tests and commit**

Run the focused tests and commit only the state/API/dispatch files and tests:

```bash
git add components/task-conversation.tsx components/harness-dashboard.tsx app/api/conversation/route.ts lib/conversation.ts lib/hive-services.ts tests/conversation-ui-behavior.test.ts tests/conversation-ui-structure.test.ts tests/conversation.test.ts
git commit -m "feat: persist unbound codex model selection"
```

### Task 4: Final regression and release checks

**Files:**
- No additional source files expected.

- [ ] **Step 1: Verify the diff is UI-safe**

Run:

```bash
git diff origin/main...HEAD --name-only
git diff origin/main...HEAD --check
```

Confirm no CSS, layout, visual copy, or unrelated generated files are staged. The component changes must be limited to data/state binding.

- [ ] **Step 2: Run focused and broad validation**

Run:

```bash
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/hive-memory-database.test.js .tmp-tests/tests/conversation-management.test.js .tmp-tests/tests/conversation-lifecycle-structure.test.js .tmp-tests/tests/conversation.test.js .tmp-tests/tests/conversation-ui-behavior.test.js .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/codex-models.test.js .tmp-tests/tests/agent-bridge-profile.test.js
npm run typecheck
npm run build
```

Expected result: all selected tests pass, typecheck exits 0, and production build completes successfully.

- [ ] **Step 3: Verify runtime persistence manually**

With the local server running, select `GPT-5.6-Sol` for Arceus in an unbound conversation, reload the page, and confirm the selector remains `GPT-5.6-Sol`. Send a message and confirm the Codex bridge receives that model; create a new conversation and confirm it falls back to the server default.

- [ ] **Step 4: Final commit/push handoff**

After all checks pass, report the commits and push the feature branch to the requested remote only after confirming the final diff contains no UI visual changes.
