# Shared Conversation History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents in the same `conversationId` share the latest 20 persisted conversation entries without replaying the same transcript into an already-running native agent session on every turn.

**Architecture:** Keep one pure shared-history normalizer for the initial seed. Add a lightweight per-process synchronization cursor keyed by agent, conversation, and native session identity. The first request for a session receives the latest 20 shareable entries; later requests receive only entries after the cursor, excluding responses produced by that same native agent because its session already contains them. A changed native session identity invalidates the cursor and triggers a new 20-entry seed. The cursor is intentionally process-local for this focused change; a bridge/process restart may cause one reseed, but normal turns never replay the full transcript.

**Tech Stack:** Next.js 16 route handlers, TypeScript, better-sqlite3 repository, Node test runner, Codex/OpenClaw bridge scripts, npm typecheck/lint/build.

---

## Scope and worktree safety

The checkout contains user-owned uncommitted changes, including full-access and conversation-lifecycle work. Do not reset, clean, stash, reformat, or stage those changes. Work in the current checkout because the requested result must be committed on `main`; stage only the files listed in this plan. The repository-wide baseline currently has unrelated `permissionMode` TypeScript failures; record them separately and do not broaden this feature to fix them.

## File map

- Existing: `lib/conversation-history.ts`: selects, labels, truncates, and formats the initial 20-entry seed. Already committed in `28a18fa`.
- Create: `lib/conversation-history-sync.ts`: computes initial seed or incremental delta and stores per-process cursors.
- Create: `tests/conversation-history-sync.test.ts`: verifies seed, delta, self-response suppression, and session reset.
- Modify: `lib/hive-services.ts`: use the sync cursor for unbound OpenClaw HTTP/A2A calls; keep bound workflow context bounded and labeled.
- Modify: `scripts/openclaw-session.mjs`: allow up to 20 history entries at the bridge boundary.
- Modify: `lib/a2a-protocol.ts`: carry conversation identity and only the current delta through both A2A envelope formats.
- Create: `tests/a2a-protocol.test.ts`: verify both A2A protocols carry conversation identity and delta history.
- Modify: `tests/openclaw-session.test.ts`: update the sanitizer cap from 12 to 20.
- Modify: `lib/codex-conversation.ts`: seed/delta the persistent Codex session and mark the delivered cursor after a successful turn request.
- Create: `tests/codex-shared-history.test.ts`: verify first seed, second-turn delta, self-response suppression, and conversation isolation.

## Definitions

- One history item is one persisted `ConversationEntry`.
- Shareable roles are `user`, `agent`, and `manager`; `system` entries and bridge activity events are excluded.
- The seed is the latest 20 shareable entries, each labeled and capped at 1,200 characters.
- A delta contains only shareable entries after the cursor. Entries authored by the target agent are omitted from deltas because that native session already saw its own output. User entries remain visible even when targeted at another agent.
- A cursor is advanced only after the external turn request succeeds. If a request fails, the same delta may be retried; bridge idempotency remains the duplicate protection.

## Acceptance criteria

1. First use of agent X in conversation A sends at most 20 entries.
2. Second successful use of agent X in conversation A sends only entries created after the first request’s cursor; it does not resend the earlier 20.
3. A response authored by agent X is not resent to X on the next turn, but responses authored by agent Y are sent to X.
4. A new native session identity for agent X in conversation A causes a fresh latest-20 seed.
5. Conversation B never contributes entries to conversation A.
6. OpenClaw HTTP and legacy/public A2A receive the same current delta and preserve the stable session identity.
7. Codex receives the same seed/delta behavior through its existing `/sessions/:id/turns` API.
8. Native OpenClaw session-key derivation and Codex session persistence are not replaced or merged.
9. Focused tests pass; full `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` are run before delivery. Any pre-existing baseline failures are reported separately.

### Task 1: Shared history contract (completed)

**Files:**
- Create: `lib/conversation-history.ts`
- Create: `tests/conversation-history.test.ts`

- [x] Implemented and committed as `28a18fa`.
- [x] Verified with focused TypeScript compilation and 2 passing tests.
- [x] The repository-wide baseline still fails in unrelated `permissionMode` tests.

### Task 2: Incremental sync engine (TDD) — complete

**Files:**
- Create: `lib/conversation-history-sync.ts`
- Create: `tests/conversation-history-sync.test.ts`

- [x] **Step 1: Write failing tests**

Test a `ConversationHistorySync` instance with these exact cases:

1. No cursor for `openclaw.gengar + conversation-a` returns the latest 20 shareable items and a cursor at the last seeded source entry.
2. The next call with the same session identity and one new Rowlet response returns only that new response plus the new user entry, not the prior seed.
3. The target Gengar response is excluded from the delta after the cursor, while a Rowlet response is retained.
4. Changing session identity from `session-a` to `session-b` returns a new latest-20 seed.
5. A cursor for `conversation-a` does not affect `conversation-b`.

- [x] **Step 2: Run focused tests and confirm RED**

```powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-history-sync.test.js
```

Expected: the new module import fails because the sync engine does not exist; unrelated repository-wide TypeScript errors may also appear.

- [x] **Step 3: Implement the minimal sync engine**

Export:

```ts
export interface ConversationHistorySyncResult {
  history: Array<{ role: "user" | "assistant"; content: string }>
  cursorEntryId?: string
}

export class ConversationHistorySync {
  getDelta(input: {
    key: string
    sessionIdentity: string
    targetAgent: string
    entries: Array<Pick<ConversationEntry, "id" | "role" | "agentId" | "content">>
  }): ConversationHistorySyncResult

  markDelivered(input: {
    key: string
    sessionIdentity: string
    cursorEntryId?: string
  }): void
}
```

Use `buildSharedConversationHistory` for a missing/mismatched cursor. For a matching cursor, locate its entry in the current shareable ordered list, take entries after it, remove entries whose `agentId` equals `targetAgent` when their role is `agent` or `manager`, and normalize the remaining entries with the same label/truncation rules. Keep the cursor in a `Map` keyed by `key`; do not persist or mutate the database in this task.

- [x] **Step 4: Run focused tests**

Compile the helper and sync test with the same narrow command used by Task 1, then run the generated test. Expected: all five sync tests pass.

- [x] **Step 5: Commit**

```powershell
git add lib/conversation-history-sync.ts tests/conversation-history-sync.test.ts
git commit -m "feat: add incremental conversation history sync"
```

### Task 3: OpenClaw HTTP/A2A integration (TDD) — complete

**Files:**
- Modify: `lib/hive-services.ts`
- Modify: `scripts/openclaw-session.mjs`
- Modify: `lib/a2a-protocol.ts`
- Modify: `tests/openclaw-session.test.ts`
- Create: `tests/a2a-protocol.test.ts`

- [x] **Step 1: Write failing integration tests**

1. Capture OpenClaw bridge payloads for two sequential calls in one conversation and assert the first has the seed while the second has only the new delta.
2. Assert a different OpenClaw agent in the same conversation receives the shared seed/delta under its own sync key.
3. Assert both `legacy-clawcodex-v0.1` and `public-a2a-v0.3` envelopes contain `conversationId` and the exact delta history.
4. Update the sanitizer fixture to use 20 valid entries and assert all 20 survive, invalid roles are removed, and content remains capped at 1,200 characters.

- [x] **Step 2: Run focused tests and confirm RED**

```powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/a2a-protocol.test.js .tmp-tests/tests/openclaw-session.test.js
```

Expected: the new payload assertions fail because the route still sends target-only history, A2A omits the fields, and the bridge cap is 12.

- [x] **Step 3: Implement OpenClaw integration**

In `lib/hive-services.ts`, instantiate one `ConversationHistorySync` for the service lifetime. For unbound OpenClaw routing, derive a stable key such as `unbound:<targetAgent>:<conversationId>` and a stable session identity such as `<targetAgent>:<conversationId>`; call `getDelta` with the full current conversation entries, pass `delta.history` to `invokeConfiguredAgent`, and call `markDelivered` only after the bridge result succeeds. Do not filter out other agents before the sync engine.

Keep bound workflow context limited to the latest 20 labeled entries; it is task-scoped context rather than the persistent unbound native session sync path.

In `scripts/openclaw-session.mjs`, set `conversationHistoryLimit` to 20 while retaining role validation and the 1,200-character cap.

In `lib/a2a-protocol.ts`, add optional `conversationId` and normalized `conversationHistory` to the envelope input and include them in the shared `createTaskPayload` used by both protocols.

- [x] **Step 4: Run focused tests**

Run the focused A2A/session tests and the existing OpenClaw lifecycle test. Expected: all pass, including stable session-key isolation for different agents and conversations.

- [x] **Step 5: Commit**

```powershell
git add lib/hive-services.ts scripts/openclaw-session.mjs lib/a2a-protocol.ts tests/openclaw-session.test.ts tests/a2a-protocol.test.ts
git commit -m "feat: incrementally sync openclaw conversation history"
```

### Task 4: Codex integration (TDD) — complete

**Files:**
- Modify: `lib/codex-conversation.ts`
- Create: `tests/codex-shared-history.test.ts`

- [x] **Step 1: Write failing tests**

Use an isolated repository and mocked Codex bridge. Post a first Codex message after inserting prior Rowlet/Gengar entries and assert the turn body contains the latest-20 seed. Complete that turn, insert a new Rowlet response, then post a second Codex message and assert the second turn body contains only the new Rowlet response and current user entry, not the previous seed and not Codex’s own prior response. Add a test that a changed `bridgeSessionId:codexThreadId` pair triggers a fresh seed and that another conversation remains excluded.

- [x] **Step 2: Run focused tests and confirm RED**

```powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/codex-shared-history.test.js
```

Expected: the first request still sends raw content, and no incremental cursor is tracked.

- [x] **Step 3: Implement Codex seed/delta forwarding**

After `ensureCodexSession`, derive `sessionIdentity = bridgeSessionId + ":" + codexThreadId`. Use a module-lifetime `ConversationHistorySync` keyed by `codex:<conversationId>`. After inserting the current user entry, call `getDelta` with the active conversation’s entries and `targetAgent: "codex"`; send `formatSharedConversationPrompt(delta.history)` to the existing `/turns` endpoint. On a successful turn request, call `markDelivered` with `delta.cursorEntryId`. Keep Codex persistence, idempotency, event cursor, pause/resume, and native session creation unchanged.

- [x] **Step 4: Run focused tests and regressions**

```powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/codex-shared-history.test.js .tmp-tests/tests/codex-conversation-structure.test.js .tmp-tests/tests/conversation.test.js
```

Expected: all listed tests pass; only the known unrelated repository-wide `permissionMode` compile errors remain.

- [x] **Step 5: Commit**

```powershell
git add lib/codex-conversation.ts tests/codex-shared-history.test.ts
git commit -m "feat: incrementally sync codex conversation history"
```

### Task 5: Full verification and delivery

- [x] **Step 1: Review scoped history**

```powershell
git status --short
git diff HEAD~4..HEAD --stat
git diff --check HEAD~4..HEAD
```

Confirm all feature commits contain only the plan, sync helper/tests, OpenClaw/A2A files/tests, and Codex files/tests. Existing pre-task dirty files remain unstaged.

- [x] **Step 2: Run all repository checks**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

Record exact results. If failures are the same pre-existing lint errors in unchanged files, report them; if a failure names a changed file, add a failing regression test before fixing it and rerun the relevant checks.

Verification result: clean worktree `npm test` passed 193/193, `npm run typecheck` passed, scoped ESLint passed for all changed files, and `npm run build` passed with a local dependency install. Full `npm run lint` still reports three pre-existing errors in unchanged files.

- [ ] **Step 3: Push and verify main**

```powershell
git push origin main
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

The remote main SHA must match local HEAD.

## Risks and mitigations

- **Repeated transcript growth:** only the first request for a native session gets the 20-entry seed; later requests get deltas.
- **Native session reset:** session identity is part of the sync key; a changed identity triggers reseeding.
- **Self-response duplication:** deltas suppress entries authored by the target agent; the native session already contains those outputs.
- **Cross-conversation leakage:** sync keys include conversation identity and callers pass only active conversation entries.
- **Prompt injection:** shared transcript is labeled untrusted and cannot override policy.
- **Process restart:** the in-memory cursor is lost and causes one reseed, not repeated full-history replay on every normal turn. A future durable ledger can eliminate that one-time reseed if needed.
- **Concurrent requests:** cursors advance only after successful dispatch; idempotency protects retries. The implementation must not advance a cursor to entries that were not part of the successful delta.

## Self-review

- The prior full-history-per-turn design has been removed from the plan.
- The plan has separate tasks for pure sync behavior, OpenClaw/A2A delivery, and Codex delivery.
- Every new behavior has a RED test and a GREEN verification command.
- The plan preserves the already committed Task 1 helper and existing dirty user changes.
