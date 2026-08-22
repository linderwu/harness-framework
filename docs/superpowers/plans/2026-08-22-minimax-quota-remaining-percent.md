# MiniMax Quota Remaining Percent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MiniMax/Lucky 5-hour quota bar use MiniMax's authoritative `current_interval_remaining_percent` value.

**Architecture:** Keep the existing dashboard quota bar and generic `AgentQuota.remainingPercent` contract. Add a small ESM MiniMax quota parser/fetcher used by `lucky-mavis-server.mjs`; it maps the official interval percentage into the generic response and returns an unavailable state when the authoritative field cannot be read. Point the dashboard quota store at the Lucky bridge and its own token so the dashboard consumes that response.

**Tech Stack:** Node.js ESM bridge, TypeScript/Next.js dashboard, Node test runner, TypeScript compiler.

---

### Task 1: Add a failing MiniMax quota parser test

**Files:**
- Create: `repos/jormungand/tests/minimax-quota.test.ts`

- [ ] **Step 1: Write the failing test**

Add a Node test that dynamically imports the source ESM module from the repository root and asserts that a `model_remains` row with `current_interval_remaining_percent: 42` returns `remainingPercent: 42`, `unit: "percent"`, and `status: "healthy"`. Add a second test asserting that a response without an authoritative interval percentage returns `status: "unavailable"`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `repos/jormungand`:

```powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/minimax-quota.test.js
```

Expected result: the test fails because `scripts/minimax-quota.mjs` does not exist yet.

### Task 2: Implement the MiniMax quota parser and fetcher

**Files:**
- Create: `repos/jormungand/scripts/minimax-quota.mjs`
- Modify: `repos/jormungand/scripts/lucky-mavis-server.mjs:48-80,1077-1103`

- [ ] **Step 1: Add the pure parser**

Implement `parseMiniMaxQuotaResponse(payload, options)` with these exact rules:

```js
const rows = Array.isArray(payload?.model_remains) ? payload.model_remains : []
const row = rows.find((candidate) => {
  const name = String(candidate?.model_name ?? "").toLowerCase()
  return name === "general" || name.includes("m3") || name.includes("m2.7")
})
const remainingPercent = Number(row?.current_interval_remaining_percent)
```

Clamp valid percentages to `0..100`; map the value to `remainingPercent`, use `unit: "percent"`, derive `weeklyUsed`/`weeklyRemaining` from a 100-point percentage scale, and use `end_time` for `resetAt`. If no valid row or percentage exists, return `status: "unavailable"` with no authoritative remaining percentage.

- [ ] **Step 2: Add the fetch helper**

Implement `fetchMiniMaxQuota({ baseUrl, token, agentId, model, fetchImpl })` to call `${baseUrl}/token_plan/remains` with `Authorization: Bearer <token>` and `Content-Type: application/json`. Remove a trailing `/chat/completions` from `baseUrl` before appending `/token_plan/remains`; preserve a `/v1` base path. Convert HTTP, JSON, and API status failures into the same unavailable quota shape.

- [ ] **Step 3: Make Lucky's `/agent-quota` return the official value**

Import the helper in `lucky-mavis-server.mjs`. In the existing `/agent-quota?executor=mavis` branch, call the helper using the configured MiniMax backend URL/token and return its normalized result. Do not use `lucky-quota-store` as the displayed percentage source.

- [ ] **Step 4: Run the focused parser test**

Run:

```powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/minimax-quota.test.js
```

Expected result: both parser tests pass.

### Task 3: Point the dashboard quota reader at Lucky

**Files:**
- Modify: `repos/jormungand/lib/agent-quota-store.ts:45-75`
- Test: `repos/jormungand/tests/agent-bridge-source.test.ts`

- [ ] **Step 1: Add source assertions**

Assert that `getLuckyQuota` uses `LUCKY_BRIDGE_URL` with a `4198` fallback and prefers `LUCKY_BRIDGE_TOKEN` (with existing bridge-token fallbacks). Assert that the Lucky bridge source imports and calls `fetchMiniMaxQuota` for `/agent-quota`.

- [ ] **Step 2: Make the minimal dashboard routing change**

Change only the Lucky quota URL/token selection. Leave `getCodexQuota`, the dashboard component, and OpenClaw cloning behavior unchanged.

- [ ] **Step 3: Run the focused source tests**

Run:

```powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/agent-bridge-source.test.js .tmp-tests/tests/minimax-quota.test.js
```

Expected result: all focused tests pass.

### Task 4: Run regression checks

**Files:**
- No additional files.

- [ ] **Step 1: Run the complete Jormungand test suite**

```powershell
npm test
```

Expected result: exit code 0 with all tests passing.

- [ ] **Step 2: Run TypeScript type checking and build**

```powershell
npm run typecheck
npm run build
```

Expected result: both commands exit 0.

- [ ] **Step 3: Review the final diff**

```powershell
git diff --check
git status --short
```

Confirm that only the quota parser, Lucky quota routing, tests, and this plan are changed; preserve unrelated pre-existing worktree changes.
