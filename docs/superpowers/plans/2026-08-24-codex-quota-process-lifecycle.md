# Codex Quota Process Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure repeated Codex quota polling performs at most one refresh per cache window and leaves no `cmd.exe -> node.exe -> codex.exe` descendants on success, failure, timeout, or bridge shutdown.

**Architecture:** Keep `/agent-quota` compatible while splitting its behavior into a module-level cache/single-flight coordinator and a fresh-read operation with a strict lifecycle. Reuse the repository's Windows `taskkill /PID <pid> /T /F` pattern as the first implementation of process-tree cleanup; make cleanup awaited, idempotent, exact-PID scoped, and shared by every Codex child path. Escalate to a native Windows Job Object only if the process-tree integration test can still produce an orphan.

**Tech Stack:** Node.js ESM, `node:child_process`, Windows `taskkill`, Node test runner, TypeScript test compilation.

---

## Context and design review

The root cause is confirmed: every uncached `GET /agent-quota` executes `codex.cmd app-server --stdio`. On Windows, `spawn(..., { shell: true })` creates a `cmd.exe` wrapper. `readCodexQuota()` currently calls `child.kill()` in `finally`; that terminates only the wrapper and can leave its Node/Codex descendants. Dashboard polling therefore created 707 wrapper trees even with no user-initiated Codex task.

The proposed four changes are necessary but need these refinements:

- Cache successful quota values for 60 seconds, configurable through `CODEX_BRIDGE_QUOTA_CACHE_TTL_MS`. Add a short 5-second failure cooldown so a broken OAuth/app-server cannot cause a spawn storm.
- Single-flight must be module-global and applied after cache lookup but before fresh spawn. The in-flight reference must clear on both resolve and reject.
- Use exact-PID process-tree cleanup first, not an immediate native Job Object dependency. The repo already has this Windows pattern in `scripts/openclaw-bridge.mjs`. A Job Object is phase two because Node core has no native Job Object API and adding a native addon increases installation and packaging risk.
- Cleanup must be awaited in `finally`, must run before the shell wrapper exits, and must be used by quota success, quota failure, quota timeout, bridge shutdown, run cancellation, and Codex session stop/delete paths.
- Add an overall quota timeout. The three current 15-second JSON-RPC requests can otherwise take up to 45 seconds and keep an app-server alive.
- Keep Mavis quota forwarding unchanged. Only the Codex quota path receives local cache/single-flight behavior.

## File map

- Modify: `repos/jormungand/scripts/codex-bridge.mjs` — cache, single-flight, fresh quota read, process-tree cleanup, shutdown cleanup.
- Create: `repos/jormungand/tests/codex-quota-lifecycle.test.ts` — integration tests with a fake `codex.cmd`/app-server process tree.
- Modify: `repos/jormungand/scripts/start-codex-bridge.ps1` — document quota cache, timeout, and failure-cooldown environment variables.
- No change: `repos/jormungand/lib/agent-quota-store.ts` — `cache: "no-store"` may remain because the bridge becomes the authoritative protection boundary.
- No change: `repos/jormungand/app/api/agent-quotas/route.ts` — public response semantics remain unchanged.

### Task 1: Add a failing quota spawn-storm regression test

**Files:**
- Create: `repos/jormungand/tests/codex-quota-lifecycle.test.ts`

- [ ] **Step 1: Create a fake Codex app-server fixture**

The test creates a temporary `codex.cmd` on Windows that launches a Node fixture. The fixture appends one line to a spawn-count file, starts a long-lived grandchild, records the grandchild PID, and implements the three JSON-RPC methods required by quota reading:

```ts
const responses: Record<string, unknown> = {
  initialize: { userAgent: "fake-codex" },
  "account/read": { account: { type: "chatgpt" } },
  "account/rateLimits/read": {
    rateLimits: {
      primary: { usedPercent: 25, resetsAt: Math.floor(Date.now() / 1000) + 3600 }
    }
  }
}
```

The fixture supports `FAKE_CODEX_MODE=success|hang|error` and writes PIDs under a test-owned temporary directory.

- [ ] **Step 2: Start the real Codex bridge against the fixture**

Use an ephemeral loopback port and these environment values:

```ts
{
  CODEX_BRIDGE_HOST: "127.0.0.1",
  CODEX_BRIDGE_PORT: String(port),
  CODEX_BRIDGE_COMMAND: fakeCodexCommand,
  CODEX_BRIDGE_QUOTA_CACHE_TTL_MS: "60000",
  CODEX_BRIDGE_QUOTA_FAILURE_TTL_MS: "5000",
  CODEX_BRIDGE_QUOTA_TIMEOUT_MS: "1000"
}
```

- [ ] **Step 3: Assert concurrent quota requests currently reproduce the bug**

Send 25 concurrent requests:

```ts
const responses = await Promise.all(
  Array.from({ length: 25 }, () => fetch(`${baseUrl}/agent-quota`))
)
assert.ok(responses.every((response) => response.status === 200))
assert.equal(await readSpawnCount(), 1)
```

Before implementation, this must fail because the count is greater than one.

- [ ] **Step 4: Assert child-tree cleanup currently reproduces the leak**

After the successful quota response, wait up to two seconds and assert the fixture grandchild PID is no longer running. Before implementation, this must fail on Windows because `child.kill()` only terminates the shell wrapper.

- [ ] **Step 5: Run the focused test and record RED**

Run:

```powershell
npm test -- --test-name-pattern="Codex quota"
```

Expected: the single-flight/spawn-count and descendant-cleanup assertions fail for the identified reasons.

### Task 2: Implement exact process-tree termination

**Files:**
- Modify: `repos/jormungand/scripts/codex-bridge.mjs`
- Test: `repos/jormungand/tests/codex-quota-lifecycle.test.ts`

- [ ] **Step 1: Add an awaited, exact-PID lifecycle helper**

Add this contract in `codex-bridge.mjs`:

```js
async function terminateProcessTree(child) {
  if (!child?.pid) return

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true }
      )
      killer.once("error", () => resolve())
      killer.once("close", () => resolve())
    })
    return
  }

  if (child.exitCode === null) child.kill("SIGTERM")
}
```

Do not enumerate arbitrary system descendants. The only kill target is the PID returned by the bridge's own `spawnCodex()` call.

- [ ] **Step 2: Add bounded close waiting and fallback**

After `taskkill`, wait for the wrapper's `close` event or a two-second deadline. If `taskkill` itself cannot start, call `child.kill("SIGTERM")` as fallback and emit one concise stderr log containing only the child PID and error message.

- [ ] **Step 3: Replace quota `child.kill()` with awaited tree cleanup**

In the fresh quota-read `finally` block:

```js
finally {
  clearTimeout(overallTimer)
  rejectPendingRequests(new Error("Codex quota reader closed."))
  await terminateProcessTree(child)
}
```

- [ ] **Step 4: Apply the same helper to all Codex child paths**

Replace direct cancellation/stop calls in these paths:

- `runCodex()` timeout and explicit cancellation.
- `stopCodexSession()` and native session delete.
- Session idle-prune cleanup.
- Bridge `SIGINT`/`SIGTERM` shutdown for active runs, sessions, and an in-flight quota child.

- [ ] **Step 5: Run the focused cleanup test and record GREEN**

Run:

```powershell
npm test -- --test-name-pattern="Codex quota.*cleanup"
```

Expected: the fake wrapper and grandchild both exit within two seconds.

### Task 3: Add quota success cache and single-flight

**Files:**
- Modify: `repos/jormungand/scripts/codex-bridge.mjs`
- Test: `repos/jormungand/tests/codex-quota-lifecycle.test.ts`

- [ ] **Step 1: Define cache state and configuration**

Add module-level state:

```js
const codexQuotaCacheTtlMs = Number(
  process.env.CODEX_BRIDGE_QUOTA_CACHE_TTL_MS ?? 60_000
)
const codexQuotaFailureTtlMs = Number(
  process.env.CODEX_BRIDGE_QUOTA_FAILURE_TTL_MS ?? 5_000
)
const codexQuotaTimeoutMs = Number(
  process.env.CODEX_BRIDGE_QUOTA_TIMEOUT_MS ?? 20_000
)
let codexQuotaCache
let codexQuotaFailure
let codexQuotaInFlight
let codexQuotaChild
```

- [ ] **Step 2: Split cached and fresh quota reads**

Rename the current implementation to `readFreshCodexQuota()`. Implement `readCodexQuota()` as:

```js
function readCodexQuota() {
  const now = Date.now()
  if (codexQuotaCache && now < codexQuotaCache.expiresAt) {
    return Promise.resolve(codexQuotaCache.value)
  }
  if (codexQuotaFailure && now < codexQuotaFailure.expiresAt) {
    return Promise.reject(codexQuotaFailure.error)
  }
  if (codexQuotaInFlight) return codexQuotaInFlight

  const request = readFreshCodexQuota()
    .then((value) => {
      codexQuotaCache = { value, expiresAt: Date.now() + codexQuotaCacheTtlMs }
      codexQuotaFailure = undefined
      return value
    })
    .catch((error) => {
      codexQuotaFailure = {
        error,
        expiresAt: Date.now() + codexQuotaFailureTtlMs
      }
      throw error
    })
    .finally(() => {
      if (codexQuotaInFlight === request) codexQuotaInFlight = undefined
    })

  codexQuotaInFlight = request
  return request
}
```

- [ ] **Step 3: Confirm cache semantics**

The cache stores only successful values for 60 seconds. Failures are held only for five seconds to prevent immediate retry storms. A later successful refresh replaces failure state. Mavis quota forwarding remains uncached by this local Codex cache.

- [ ] **Step 4: Extend tests for TTL and single-flight**

Add assertions:

- 25 concurrent requests cause one fixture spawn.
- 25 sequential requests inside the TTL cause no additional spawn.
- After a short test TTL expires, one new request causes exactly one additional spawn.
- All responses return the same quota payload during one cache window.

- [ ] **Step 5: Run the focused cache tests**

Run:

```powershell
npm test -- --test-name-pattern="Codex quota.*(cache|single-flight)"
```

Expected: all cache and single-flight tests pass.

### Task 4: Make timeout and failure cleanup terminal

**Files:**
- Modify: `repos/jormungand/scripts/codex-bridge.mjs`
- Test: `repos/jormungand/tests/codex-quota-lifecycle.test.ts`

- [ ] **Step 1: Add one overall quota deadline**

Wrap initialize/account/rate-limit reads in one `Promise.race` controlled by `CODEX_BRIDGE_QUOTA_TIMEOUT_MS`. Do not rely only on three independent 15-second request timers.

- [ ] **Step 2: Reject all pending JSON-RPC requests on close/error/timeout**

Store `{ resolve, reject, timer }` per request. On child `error`, unexpected `close`, or overall timeout, clear every request timer, reject every pending promise, and clear the map.

- [ ] **Step 3: Always await tree cleanup in `finally`**

Success, invalid JSON, OAuth error, timeout, stdin error, and unexpected close must all enter the same `finally` path. Cleanup errors are logged and never replace the original quota error.

- [ ] **Step 4: Add failure-cooldown tests**

For `FAKE_CODEX_MODE=error`, send ten concurrent requests and assert one spawn. Repeat inside the five-second failure TTL and assert no new spawn. After TTL expiry, assert one retry spawn.

- [ ] **Step 5: Add timeout-recovery tests**

For `FAKE_CODEX_MODE=hang`, assert:

- The route returns `500` before the configured test timeout plus two seconds.
- Wrapper and grandchild PIDs are gone.
- `codexQuotaInFlight` clears, proven by switching the fixture to success and receiving a successful later response.

### Task 5: Document configuration and add observability

**Files:**
- Modify: `repos/jormungand/scripts/start-codex-bridge.ps1`
- Modify: `repos/jormungand/scripts/codex-bridge.mjs`

- [ ] **Step 1: Document the three quota controls**

Add these optional variables to the launcher header:

```text
CODEX_BRIDGE_QUOTA_CACHE_TTL_MS    default 60000
CODEX_BRIDGE_QUOTA_FAILURE_TTL_MS  default 5000
CODEX_BRIDGE_QUOTA_TIMEOUT_MS      default 20000
```

- [ ] **Step 2: Add non-secret lifecycle logs**

Emit one-line debug logs only when `CODEX_BRIDGE_QUOTA_DEBUG=1`:

```text
codex-quota cache-hit
codex-quota single-flight-join
codex-quota spawn pid=<pid>
codex-quota cleanup pid=<pid> outcome=<ok|fallback|failed>
```

Do not print OAuth data, tokens, quota response bodies, command arguments, or environment values.

### Task 6: Full verification and rollout

**Files:**
- Verify: `repos/jormungand/scripts/codex-bridge.mjs`
- Verify: `repos/jormungand/tests/codex-quota-lifecycle.test.ts`
- Verify: `repos/jormungand/scripts/start-pokemon-center-server.ps1`

- [ ] **Step 1: Run syntax and focused tests**

```powershell
node --check scripts/codex-bridge.mjs
npm test -- --test-name-pattern="Codex quota"
```

Expected: syntax succeeds; all quota lifecycle tests pass.

- [ ] **Step 2: Run the complete test suite**

```powershell
npm test
```

Expected: all existing and new tests pass.

- [ ] **Step 3: Confirm a clean pre-start state**

Before restarting, count exact wrappers:

```powershell
@(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "cmd.exe" -and
  $_.CommandLine -match "codex\.cmd app-server --stdio"
}).Count
```

Expected: `0`.

- [ ] **Step 4: Start one bridge instance and exercise concurrent quota polling**

Start through `start-pokemon-center-server.ps1`, then send 100 concurrent authenticated `GET /agent-quota` requests. Expected results:

- All responses are `200`.
- One fresh Codex app-server is spawned for the burst.
- The exact wrapper count returns to `0` within two seconds.
- Requests during the next 60 seconds do not spawn another app-server.

- [ ] **Step 5: Verify failure and timeout in the fixture environment**

Do not intentionally break production OAuth. Use only the test fixture to prove failure and timeout cleanup.

- [ ] **Step 6: Perform a five-minute idle observation**

With dashboard polling active but no user tasks, sample every ten seconds:

- Codex Bridge PID and private memory.
- Exact `codex.cmd app-server --stdio` wrapper count.
- Total descendant count for the Bridge PID.

Acceptance criteria:

- Wrapper count is `0` between refresh operations.
- Descendant count returns to its baseline after every refresh.
- No monotonic process-count growth.
- Bridge private memory remains within 20 MB of the post-warmup baseline.

## Rollback boundary

If cache semantics cause stale UI data, reduce `CODEX_BRIDGE_QUOTA_CACHE_TTL_MS` to `30000`; do not remove single-flight or process-tree cleanup. If `taskkill /T /F` still leaves descendants in the integration test, stop rollout and implement a Windows Job Object helper behind the same `terminateProcessTree()` interface rather than adding more PID-enumeration logic.
