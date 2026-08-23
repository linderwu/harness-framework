# Harness OpenClaw Persistent Direct Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Route every authenticated Harness conversation directly to a stable, per-agent OpenClaw persistent session with no unbound-only tool prohibition, while preserving authentication, audit, workflow behavior, and Harness-side deletion semantics.

**Architecture:** Keep workflow binding and runtime session binding separate. A server-owned \`harness-direct-v1\` session key is derived from (conversationId, OpenClaw agent). A new SQLite runtime-session table persists bootstrap/delivery state; direct routing sends bootstrap history once per conversation-agent pair and then relies on OpenClaw's persistent transcript.

**Tech Stack:** TypeScript, Next.js server modules, Node test runner, better-sqlite3 migrations, OpenClaw HTTP/A2A bridge adapters, SQLite-backed Hive memory.

---

## File map and ownership

- \`repos/jormungand/scripts/openclaw-session.mjs\`: canonical deterministic OpenClaw session namespace and bounded-key derivation.
- \`repos/jormungand/lib/openclaw-session.ts\`: typed server adapter for the canonical ESM helper and session-key fingerprinting.
- \`repos/jormungand/lib/hive-memory/schema.ts\`: schema migration for durable OpenClaw runtime-session state.
- \`repos/jormungand/lib/hive-memory/types.ts\`: runtime-session types.
- \`repos/jormungand/lib/hive-memory/repository.ts\`: runtime-session CRUD and Harness-conversation deletion cleanup.
- \`repos/jormungand/lib/hive-services.ts\`: one direct unbound route for Codex and OpenClaw, with OpenClaw bootstrap/delivery persistence.
- \`repos/jormungand/lib/agent-bridge.ts\`: reuse the typed session adapter so HTTP and A2A paths share the same namespace implementation.
- \`repos/jormungand/tests/openclaw-session.test.ts\`: key stability, namespace, isolation, length, and fingerprint tests.
- \`repos/jormungand/tests/hive-memory-repository.test.ts\`: migration, runtime-session persistence, restart, and delete-unlink tests.
- \`repos/jormungand/tests/conversation-lifecycle-structure.test.ts\`: direct dispatch, bootstrap-once, failure cursor, and per-agent isolation tests.
- \`repos/jormungand/tests/bridge-security.test.ts\`: direct skill and bridge boundary assertions.
- \`repos/jormungand/README.md\` and \`repos/jormungand/docs/openclaw-ssh.md\`: operator configuration and live verification instructions.

Do not modify existing unrelated worktree changes. Stage only files named by each task. Do not change project-bound workflow routing or bridge authentication.

## Task 1: Canonical versioned OpenClaw session identity

**Files:**
- Modify: \`repos/jormungand/scripts/openclaw-session.mjs\`
- Create: \`repos/jormungand/lib/openclaw-session.ts\`
- Modify: \`repos/jormungand/lib/agent-bridge.ts\`
- Test: \`repos/jormungand/tests/openclaw-session.test.ts\`
- Test: \`repos/jormungand/tests/conversation-lifecycle-structure.test.ts\`

- [ ] **Step 1: Add failing identity tests.**

Extend \`openclaw-session.test.ts\` with:

~~~ts
test("direct session keys use a stable versioned Harness namespace", async () => {
  const helper = await loadSessionHelper()
  const key = helper.deriveOpenClawSessionKey({
    mainAgent: "gengar",
    conversationId: "conversation:abc"
  })

  assert.equal(key, "agent:gengar:harness-direct-v1-conversation-abc")
})

test("direct session identity exposes a deterministic fingerprint", async () => {
  const helper = await loadSessionHelper()
  const first = helper.deriveOpenClawSessionIdentity({
    mainAgent: "gengar",
    conversationId: "conversation:abc"
  })
  const second = helper.deriveOpenClawSessionIdentity({
    mainAgent: "gengar",
    conversationId: "conversation:abc"
  })

  assert.deepEqual(first, second)
  assert.match(first.sessionKeyFingerprint, /^sha256:[0-9a-f]{64}$/)
})
~~~

Update the long-key assertion to require \`harness-direct-v1\` and retain existing same-conversation/different-agent/different-conversation isolation checks.

Run:

~~~powershell
Set-Location repos/jormungand
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="direct session|OpenClaw session" .tmp-tests/tests/openclaw-session.test.js .tmp-tests/tests/conversation-lifecycle-structure.test.js
~~~

Expected: FAIL because the helper has no versioned namespace or identity fingerprint export.

- [ ] **Step 2: Verify the failure is about missing behavior.**

Confirm the failure names the old \`harness-conversation\` key or missing \`deriveOpenClawSessionIdentity\`, not a TypeScript syntax or fixture error.

- [ ] **Step 3: Implement the canonical helper.**

Change the conversation branch in \`openclaw-session.mjs\` to construct:

~~~js
agent:<mainAgent>:harness-direct-v1-<sanitized-conversation-id>
~~~

Add \`deriveOpenClawSessionIdentity(input)\` returning \`sessionKey\` and \`sha256:<64 lowercase hex>\` fingerprint. Keep caller-supplied \`sessionKey\` ignored, keep the 160-character cap, and leave workflow fallback key behavior unchanged.

Create \`lib/openclaw-session.ts\` with a typed dynamic import of the ESM helper. Move the duplicate loader logic in \`agent-bridge.ts\` to this adapter and keep \`getOpenClawSessionKey()\` behavior unchanged apart from using the new helper.

- [ ] **Step 4: Run focused tests green.**

~~~powershell
Set-Location repos/jormungand
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="direct session|OpenClaw session" .tmp-tests/tests/openclaw-session.test.js .tmp-tests/tests/conversation-lifecycle-structure.test.js
~~~

Expected: all selected identity and existing session tests pass.

- [ ] **Step 5: Commit the identity unit.**

~~~powershell
git add -- scripts/openclaw-session.mjs lib/openclaw-session.ts lib/agent-bridge.ts tests/openclaw-session.test.ts tests/conversation-lifecycle-structure.test.ts
git commit -m "feat: version OpenClaw direct session identities"
~~~

## Task 2: Persist OpenClaw runtime-session state

**Files:**
- Modify: \`repos/jormungand/lib/hive-memory/schema.ts\`
- Modify: \`repos/jormungand/lib/hive-memory/types.ts\`
- Modify: \`repos/jormungand/lib/hive-memory/repository.ts\`
- Test: \`repos/jormungand/tests/hive-memory-repository.test.ts\`
- Test: \`repos/jormungand/tests/conversation-management.test.ts\`

- [ ] **Step 1: Add failing repository tests.**

Add a restart test that calls \`upsertOpenClawRuntimeSession()\`, closes the database, reopens it, and asserts \`bootstrapDelivered\` and \`lastDeliveredEntryId\` survive. Add a deletion assertion that inserts a runtime row, calls \`deleteConversation(conversationId)\`, then asserts \`getOpenClawRuntimeSession()\` is undefined.

Run the focused repository tests. Expected: FAIL because migration v8 and the repository methods do not exist.

- [ ] **Step 2: Add the typed runtime-session contract.**

In \`hive-memory/types.ts\`, add:

~~~ts
export type OpenClawRuntimeSessionState =
  | "pending"
  | "active"
  | "delivery_unknown"

export interface OpenClawRuntimeSession {
  conversationId: string
  agentId: import("../types").AgentKind
  provider: "openclaw"
  sessionNamespace: "harness-direct-v1"
  state: OpenClawRuntimeSessionState
  sessionKeyFingerprint: string
  bootstrapDelivered: boolean
  lastDeliveredEntryId?: string
  createdAt: string
  updatedAt: string
}

export interface UpsertOpenClawRuntimeSessionInput {
  conversationId: string
  agentId: import("../types").AgentKind
  sessionNamespace: "harness-direct-v1"
  state: OpenClawRuntimeSessionState
  sessionKeyFingerprint: string
  bootstrapDelivered: boolean
  lastDeliveredEntryId?: string
}
~~~

- [ ] **Step 3: Add schema migration v8.**

Set \`hiveSchemaVersion\` to 8 and add/apply a migration creating \`openclaw_runtime_sessions\` with a composite primary key \`(conversation_id, agent_id)\`, provider and namespace checks, state check for \`pending|active|delivery_unknown\`, fingerprint, boolean bootstrap flag, optional last entry ID, and created/updated timestamps. Add an updated-at index. Apply it after v7 through the existing migration table.

- [ ] **Step 4: Implement repository persistence and unlink cleanup.**

Add \`getOpenClawRuntimeSession()\` and \`upsertOpenClawRuntimeSession()\` beside the existing conversation/session methods. \`upsert\` updates state, fingerprint, bootstrap flag, last entry, and \`updated_at\` without replacing \`created_at\`. Map SQLite integer flags to booleans.

In \`deleteConversation()\`, delete runtime-session rows for the conversation inside the existing transaction. Do not call an OpenClaw API or delete a remote session.

- [ ] **Step 5: Run repository and migration tests green.**

~~~powershell
Set-Location repos/jormungand
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="OpenClaw runtime session|conversation deletion|schema v8" .tmp-tests/tests/hive-memory-repository.test.js .tmp-tests/tests/conversation-management.test.js
~~~

Expected: focused repository tests pass and existing deletion tests remain green.

- [ ] **Step 6: Commit the durable state unit.**

~~~powershell
git add -- lib/hive-memory/schema.ts lib/hive-memory/types.ts lib/hive-memory/repository.ts tests/hive-memory-repository.test.ts tests/conversation-management.test.ts
git commit -m "feat: persist OpenClaw runtime session state"
~~~

## Task 3: Direct unbound dispatch with bootstrap-once history

**Files:**
- Modify: \`repos/jormungand/lib/hive-services.ts\`
- Modify only if required by the existing result types: \`repos/jormungand/lib/conversation.ts\`, \`repos/jormungand/lib/conversation-dispatcher.ts\`
- Test: \`repos/jormungand/tests/conversation-lifecycle-structure.test.ts\`
- Test: \`repos/jormungand/tests/bridge-security.test.ts\`

- [ ] **Step 1: Add failing direct-routing tests against the real service.**

Replace old limited-mode expectations with tests using \`createHiveServices\` and an injected \`invokeAgent\`. Assert that an OpenClaw unbound message:

~~~ts
assert.equal(invocations[0].skill.id, "conversation.direct_execution")
assert.doesNotMatch(
  JSON.stringify(invocations[0].skill),
  /unbound_limited|read-only|Do not invoke external/i
)
~~~

Add tests proving first successful OpenClaw delivery sends bounded bootstrap history and persists \`bootstrapDelivered\`; the second same-agent turn sends no bootstrap history; failed first delivery leaves bootstrap pending; switching agent bootstraps separately; different conversations get separate rows; Codex direct messages use the same direct skill; and target agent/conversation identity reaches the bridge payload.

Run focused tests before production changes. Expected failures must show the old manager route or \`conversation.unbound_limited\`.

- [ ] **Step 2: Implement the direct skill factory.**

Add a typed helper in \`hive-services.ts\` with:

~~~ts
id: "conversation.direct_execution"
purpose: "Execute the authenticated operator request directly without requiring project or workflow binding."
constraints: ["Report tool results, side effects, and blockers accurately."]
gates: ["Server authentication and bridge authorization remain required."]
~~~

It must not include project-binding, manager-routing, external-action, irreversible-action, or read-only prohibitions.

- [ ] **Step 3: Replace the two-branch unbound router.**

Replace the \`targetAgent === "codex"\` manager branch in \`createHiveServices\` with one call to \`routeUnboundConversation\` for every target agent. Keep the manager scheduler for bound workflow runs unchanged.

The direct route must create only the synthetic invocation envelope, inspect the OpenClaw runtime row, include bounded shareable history only while bootstrap is false, invoke the selected agent with the direct skill/current content, mark active/bootstrap-delivered/last-entry only after a completed result, leave pending on definitive failure, and return through the existing conversation lifecycle.

Use \`deriveOpenClawSessionIdentity()\` to persist only the fingerprint. The bridge remains responsible for deriving and passing the full session key to OpenClaw. Preserve existing Codex history behavior and do not add OpenClaw-specific state to bound workflows.

- [ ] **Step 4: Handle transport uncertainty without automatic side effects.**

Inspect the existing \`AgentArtifactResult\` and bridge response mapping. If a timeout is distinguishable, persist \`delivery_unknown\` and never automatically retry. If the current bridge collapses timeout into ordinary failure, preserve the public contract and add an audit/status message explaining that retry is operator-authorized; do not create an automatic second execution.

- [ ] **Step 5: Run direct-routing tests green.**

~~~powershell
Set-Location repos/jormungand
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="unbound|direct conversation|OpenClaw bridge session identity" .tmp-tests/tests/conversation-lifecycle-structure.test.js .tmp-tests/tests/bridge-security.test.js
~~~

- [ ] **Step 6: Commit the routing unit.**

~~~powershell
git add -- lib/hive-services.ts lib/conversation.ts lib/conversation-dispatcher.ts tests/conversation-lifecycle-structure.test.ts tests/bridge-security.test.ts
git commit -m "feat: dispatch direct conversations to OpenClaw sessions"
~~~

## Task 4: Document OpenClaw runtime prerequisites and operator checks

**Files:**
- Modify: \`repos/jormungand/README.md\`
- Modify: \`repos/jormungand/docs/openclaw-ssh.md\`

- [ ] **Step 1: Document the effective OpenClaw policy.**

Add the required configuration:

~~~json5
{
  agents: { defaults: { sandbox: { mode: "off" } } },
  tools: {
    profile: "full",
    exec: { host: "gateway", mode: "full" }
  }
}
~~~

Explain that \`tools.deny\`, provider/sender restrictions, and per-agent sandbox overrides can narrow the effective policy. Explain that the OpenClaw container must contain \`yt-dlp\`, FFmpeg, the transcription engine, network access, credentials, and writable mounts.

- [ ] **Step 2: Document the persistent-session smoke checklist.**

Document checks for \`openclaw agents list --bindings\`, \`openclaw sessions --json\`, a direct \`openclaw agent --session-key\` health check, same-conversation continuity, different-conversation isolation, Harness restart continuity, and Harness deletion leaving the remote session intact. Do not add real tokens or private URLs.

- [ ] **Step 3: Run documentation checks and commit.**

~~~powershell
git diff --check -- README.md docs/openclaw-ssh.md
git add -- README.md docs/openclaw-ssh.md
git commit -m "docs: document OpenClaw direct session prerequisites"
~~~

## Task 5: Full verification and merge into dev

**Files:** Verify only all implementation files from Tasks 1-4.

- [ ] **Step 1: Run the focused tests.**

~~~powershell
Set-Location repos/jormungand
npx tsc -p tsconfig.tests.json
node --test --test-name-pattern="direct session|OpenClaw runtime session|unbound|conversation deletion" .tmp-tests/tests/openclaw-session.test.js .tmp-tests/tests/hive-memory-repository.test.js .tmp-tests/tests/conversation-lifecycle-structure.test.js .tmp-tests/tests/conversation-management.test.js
~~~

- [ ] **Step 2: Run all quality gates.**

~~~powershell
npm test
npm run typecheck
npm run lint
npm run build
~~~

Record exit codes and failure counts. Report unrelated failures by exact path/error rather than fixing them opportunistically.

- [ ] **Step 3: Review against the design.**

Confirm the only new namespace is \`harness-direct-v1\`; direct payloads contain no \`conversation.unbound_limited\`; authentication and bridge tokens are untouched; migration is idempotent; same conversation/agent reuses identity; different conversations/agents are isolated; bootstrap does not rely on process memory; and Harness deletion does not delete OpenClaw sessions.

- [ ] **Step 4: Merge the tested branch into \`dev\` safely.**

The local \`dev\` worktree currently has user modifications. Inspect status immediately before merge. If changed paths overlap the feature diff, stop and report them. If they do not overlap, merge from the dev worktree:

~~~powershell
git -C C:\Users\linder\Documents\harness-framework-dev merge --no-ff codex/openclaw-direct-sessions
~~~

Do not stash, reset, or overwrite the user's dev-worktree changes without explicit approval.

- [ ] **Step 5: Verify \`dev\` after merge.**

~~~powershell
git -C C:\Users\linder\Documents\harness-framework-dev status --short --branch
git -C C:\Users\linder\Documents\harness-framework-dev log -3 --oneline --decorate
~~~

Run the focused direct-session tests from the dev worktree after merging. Report the merge commit and any remote OpenClaw prerequisites that cannot be verified locally.

## Plan self-review

- Spec coverage: session identity, direct dispatch, full tool policy, persistent bootstrap state, lifecycle, idempotency, failure handling, security, migration, tests, documentation, and dev handoff each map to a task.
- No production task assumes Harness can grant permissions to a remote OpenClaw container.
- No task deletes remote OpenClaw sessions when Harness conversations are deleted.
- Bound workflow manager behavior and bridge authentication remain outside the direct-route change.
- No placeholders or undefined helper names remain in the task sequence.
