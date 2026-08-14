# Registered Bridge Cards Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move bridge connection cards into the left blue setup panel and show only configured HTTP bridge URLs.

**Architecture:** Make `/api/agent-health` return only registered HTTP bridge records for `CODEX_BRIDGE_URL` and `OPENCLAW_BRIDGE_URL`. Render `BridgeStatusPanel` inside the compose panel below the project action buttons, deriving cards from endpoint data rather than fixed viewport bridge definitions.

**Tech Stack:** Next.js route handlers, React client component code in `components/harness-dashboard.tsx`, CSS in `app/globals.css`, Node test runner structure tests, TypeScript.

---

## File Structure

- Modify: `app/api/agent-health/route.ts`
  - Remove A2A/manual bridge records.
  - Return only configured HTTP bridge URLs.
  - Include safe `urlHost` metadata, not full URL or tokens.
- Modify: `components/harness-dashboard.tsx`
  - Move `BridgeStatusPanel` into `composePanel` under `.runActionRow`.
  - Remove floating toggle behavior.
  - Render cards from health response records.
  - Map agent rows from each bridge id.
- Modify: `app/globals.css`
  - Replace fixed bottom-right styling with in-panel card styling.
  - Remove mobile overlay/toggle collapse rules.
- Modify: `tests/harness-dashboard-structure.test.ts`
  - Update endpoint and placement tests.
- Modify: `tests/layout-css.test.ts`
  - Replace fixed overlay assertions with in-panel styling assertions.

## Task 1: Restrict Health Endpoint to Registered HTTP Bridge URLs

**Files:**
- Modify: `app/api/agent-health/route.ts`
- Modify: `tests/harness-dashboard-structure.test.ts`

- [ ] **Step 1: Write the failing endpoint test**

Replace the current `dashboard has a bridge health endpoint contract` test with:

```ts
test("dashboard health endpoint only returns registered HTTP bridge URL records", () => {
  const route = readFileSync("app/api/agent-health/route.ts", "utf8")

  assert.match(route, /CODEX_BRIDGE_URL/)
  assert.match(route, /OPENCLAW_BRIDGE_URL/)
  assert.match(route, /urlHost/)
  assert.doesNotMatch(route, /OPENCLAW_A2A_COMMAND/)
  assert.doesNotMatch(route, /openclaw-a2a/)
  assert.doesNotMatch(route, /Manual \/ Simulated/)
  assert.doesNotMatch(route, /not_configured/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm.cmd run test
```

Expected: FAIL because the route still includes A2A/manual/not-configured behavior.

- [ ] **Step 3: Implement the endpoint change**

Change `app/api/agent-health/route.ts` so the top-level types and `GET` function look like:

```ts
import { NextResponse } from "next/server"

type BridgeHealthStatus = "online" | "offline"

interface BridgeHealth {
  id: "codex-bridge" | "openclaw-bridge"
  label: string
  status: BridgeHealthStatus
  urlHost: string
  protocolVersion?: string
  capabilities?: string[]
  message?: string
}

const healthTimeoutMs = 2500

export async function GET() {
  const bridgeChecks = [
    createHttpBridgeCheck({
      id: "codex-bridge",
      label: "Codex Bridge",
      url: process.env.CODEX_BRIDGE_URL,
      token: process.env.CODEX_BRIDGE_TOKEN
    }),
    createHttpBridgeCheck({
      id: "openclaw-bridge",
      label: "OpenClaw Bridge",
      url: process.env.OPENCLAW_BRIDGE_URL,
      token: process.env.OPENCLAW_BRIDGE_TOKEN
    })
  ].filter((check): check is HttpBridgeCheck => Boolean(check))

  const bridges = await Promise.all(bridgeChecks.map(checkHttpBridge))

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    bridges
  })
}
```

Add this helper:

```ts
interface HttpBridgeCheck {
  id: BridgeHealth["id"]
  label: string
  url: string
  token?: string
  urlHost: string
}

function createHttpBridgeCheck(input: {
  id: BridgeHealth["id"]
  label: string
  url?: string
  token?: string
}): HttpBridgeCheck | undefined {
  if (!input.url) {
    return undefined
  }

  return {
    id: input.id,
    label: input.label,
    url: input.url,
    token: input.token,
    urlHost: new URL(input.url).host
  }
}
```

Update `checkHttpBridge` to accept `HttpBridgeCheck` and always return `urlHost`:

```ts
async function checkHttpBridge(input: HttpBridgeCheck): Promise<BridgeHealth> {
  try {
    const response = await fetch(new URL("health", normalizeUrl(input.url)), {
      cache: "no-store",
      headers: input.token ? { Authorization: `Bearer ${input.token}` } : {},
      signal: AbortSignal.timeout(healthTimeoutMs)
    })
    const data = (await response.json().catch(() => ({}))) as {
      protocolVersion?: string
      capabilities?: string[]
      error?: string
    }

    return {
      id: input.id,
      label: input.label,
      status: response.ok ? "online" : "offline",
      urlHost: input.urlHost,
      protocolVersion: data.protocolVersion,
      capabilities: data.capabilities,
      message: response.ok
        ? "Health check succeeded."
        : data.error ?? `Health check failed with HTTP ${response.status}.`
    }
  } catch (error) {
    return {
      id: input.id,
      label: input.label,
      status: "offline",
      urlHost: input.urlHost,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
```

Remove `checkCommandBridge` entirely.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```powershell
npm.cmd run test
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add app/api/agent-health/route.ts tests/harness-dashboard-structure.test.ts
git commit -m "Limit bridge health to registered URLs"
```

Use Lore trailers and include `Co-authored-by: OmX <omx@oh-my-codex.dev>`.

## Task 2: Move Bridge Cards into the Compose Panel

**Files:**
- Modify: `components/harness-dashboard.tsx`
- Modify: `tests/harness-dashboard-structure.test.ts`

- [ ] **Step 1: Write failing placement and definition tests**

Replace the existing bridge placement/grouping tests in `tests/harness-dashboard-structure.test.ts` with:

```ts
test("dashboard renders bridge status inside the compose panel action area", () => {
  const composePanel = dashboard.slice(
    dashboard.indexOf('<form className="panel composePanel"'),
    dashboard.indexOf("</form>", dashboard.indexOf('<form className="panel composePanel"'))
  )
  const actionRowIndex = composePanel.indexOf('className="runActionRow"')
  const bridgePanelIndex = composePanel.indexOf("<BridgeStatusPanel")
  const errorIndex = composePanel.indexOf("{mutationError ?")

  assert.ok(actionRowIndex > -1, "Expected action row in compose panel")
  assert.ok(bridgePanelIndex > actionRowIndex, "Expected bridge panel after action row")
  assert.ok(errorIndex > bridgePanelIndex, "Expected mutation error after bridge panel")
  assert.doesNotMatch(
    dashboard.slice(dashboard.indexOf("</section>"), dashboard.indexOf("</main>")),
    /<BridgeStatusPanel/
  )
})

test("bridge status panel renders endpoint bridges instead of fixed bridge definitions", () => {
  const panel = functionBody("BridgeStatusPanel")

  assert.match(panel, /visibleBridges\.map/)
  assert.match(panel, /getBridgeAgents\(bridge\.id\)/)
  assert.doesNotMatch(dashboard, /const bridgeDefinitions/)
  assert.doesNotMatch(dashboard, /openclaw-a2a/)
  assert.doesNotMatch(dashboard, /Manual \/ Simulated/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm.cmd run test
```

Expected: FAIL because the panel is still outside the compose panel and uses `bridgeDefinitions`.

- [ ] **Step 3: Update bridge types**

In `components/harness-dashboard.tsx`, change:

```ts
type BridgeHealthStatus = "online" | "offline" | "not_configured"
type BridgePanelStatus = BridgeHealthStatus | "checking" | "stale"

type BridgeId =
  | "codex-bridge"
  | "openclaw-bridge"
  | "openclaw-a2a"
  | "manual"
```

to:

```ts
type BridgeHealthStatus = "online" | "offline"
type BridgePanelStatus = BridgeHealthStatus | "checking" | "stale"
type BridgeId = "codex-bridge" | "openclaw-bridge"
```

Add `urlHost` to `BridgeHealth`:

```ts
interface BridgeHealth {
  id: BridgeId
  label: string
  status: BridgeHealthStatus
  urlHost: string
  protocolVersion?: string
  capabilities?: string[]
  message?: string
}
```

Delete `BridgeDefinition` and `bridgeDefinitions`.

- [ ] **Step 4: Move the component call**

Move:

```tsx
      <BridgeStatusPanel run={selectedRun} />
```

from before `</main>` to immediately after the `runActionRow` `</div>` and before `{mutationError ? (` inside the compose panel:

```tsx
          <BridgeStatusPanel run={selectedRun} />

          {mutationError ? (
```

- [ ] **Step 5: Render endpoint bridges**

Inside `BridgeStatusPanel`, replace `bridgeDefinitions.map` rendering with:

```tsx
  const visibleBridges = Object.values(health)
  const panelStatus = getAggregateBridgeStatus({
    failureCount,
    health,
    isChecking,
    isStale: Boolean(isStale)
  })

  return (
    <aside className="bridgeStatusPanel" aria-label="Agent bridge status">
      <div className="bridgeStatusPanelHeader">
        <span>
          {panelStatus === "online" ? <Wifi size={16} /> : <WifiOff size={16} />}
          <strong>Bridge Connections</strong>
        </span>
        <button
          className="iconButton bridgeRefreshButton"
          onClick={refreshBridgeHealth}
          title="Refresh bridge health"
          type="button"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {visibleBridges.length === 0 ? (
        <p className="bridgeStatusEmpty">No bridge URLs registered</p>
      ) : (
        <div className="bridgeStatusCards">
          {visibleBridges.map((bridge) => (
            <BridgeStatusCard
              failureCount={failureCount}
              health={bridge}
              isChecking={isChecking}
              isStale={Boolean(isStale)}
              key={bridge.id}
              lastSuccessAt={lastSuccessAt}
              now={now}
              run={run}
            />
          ))}
        </div>
      )}
    </aside>
  )
```

Remove `isOpen` and the floating toggle button.

- [ ] **Step 6: Update card and agent mapping**

Change `BridgeStatusCard` props to remove `bridge` and `onRefresh`, and render:

```tsx
<strong>{health?.label}</strong>
<small>{health?.urlHost}</small>
```

Replace `bridge.agents.map(...)` with:

```tsx
{getBridgeAgents(health.id).map((agent) => (
  <AgentBridgeRow agent={agent} key={agent} run={run} />
))}
```

Add helper:

```ts
function getBridgeAgents(bridgeId: BridgeId): AgentKind[] {
  if (bridgeId === "codex-bridge") {
    return ["codex"]
  }

  return ["openclaw.rowlet", "openclaw.roaringmoon", "openclaw.charizard"]
}
```

Update `getAggregateBridgeStatus` to iterate `Object.values(health)` instead of `bridgeDefinitions`.

- [ ] **Step 7: Run the test to verify it passes**

Run:

```powershell
npm.cmd run test
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add components/harness-dashboard.tsx tests/harness-dashboard-structure.test.ts
git commit -m "Move registered bridge cards into setup panel"
```

Use Lore trailers and include `Co-authored-by: OmX <omx@oh-my-codex.dev>`.

## Task 3: Replace Floating Overlay CSS with In-Panel Styles

**Files:**
- Modify: `app/globals.css`
- Modify: `tests/layout-css.test.ts`

- [ ] **Step 1: Write failing CSS test**

Replace `bridge status panel is fixed on desktop and collapses on mobile` with:

```ts
test("bridge status panel is embedded in the compose panel", () => {
  const panelRule = ruleBody(/\.bridgeStatusPanel/, ".bridgeStatusPanel")
  const cardsRule = ruleBody(/\.bridgeStatusCards/, ".bridgeStatusCards")

  assert.doesNotMatch(panelRule, /position:\s*fixed;/)
  assert.doesNotMatch(panelRule, /bottom:\s*18px;/)
  assert.doesNotMatch(panelRule, /right:\s*18px;/)
  assert.match(panelRule, /background:\s*rgba\(255, 255, 255, 0\.08\);/)
  assert.match(cardsRule, /grid-template-columns:\s*1fr;/)
  assert.doesNotMatch(css, /\.bridgeStatusToggle/)
  assert.doesNotMatch(css, /\.bridgeStatusCards:not\(\.open\)/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm.cmd run test
```

Expected: FAIL because CSS still describes a fixed overlay.

- [ ] **Step 3: Replace bridge CSS**

Replace the `.bridgeStatusPanel` through `.bridgeAgentRow` CSS block with in-panel styles:

```css
.bridgeStatusPanel {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(203, 213, 225, 0.18);
  border-radius: 8px;
  display: grid;
  gap: 10px;
  padding: 12px;
}

.bridgeStatusPanelHeader,
.bridgeStatusPanelHeader span,
.bridgeStatusMeta,
.bridgeAgentRow {
  align-items: center;
  display: flex;
}

.bridgeStatusPanelHeader {
  justify-content: space-between;
}

.bridgeStatusPanelHeader span {
  color: #f8fbff;
  gap: 7px;
  min-width: 0;
}

.bridgeStatusEmpty {
  color: #bfd2e5;
  font-size: 12px;
  font-weight: 700;
  margin: 0;
}

.bridgeStatusCards {
  display: grid;
  gap: 8px;
  grid-template-columns: 1fr;
}

.bridgeStatusCard {
  background: rgba(248, 251, 255, 0.94);
  border: 1px solid rgba(207, 219, 231, 0.82);
  border-radius: 8px;
  display: grid;
  gap: 8px;
  padding: 10px;
}

.bridgeStatusCard.online {
  border-color: rgba(153, 246, 228, 0.58);
}

.bridgeStatusCard.offline,
.bridgeStatusCard.stale {
  border-color: rgba(254, 202, 202, 0.72);
}

.bridgeStatusCard.checking {
  border-color: rgba(253, 230, 138, 0.7);
}

.bridgeStatusCardHeader,
.bridgeStatusCardHeader span {
  align-items: center;
  display: flex;
}

.bridgeStatusCardHeader {
  justify-content: space-between;
}

.bridgeStatusCardHeader span {
  color: var(--text);
  gap: 7px;
  min-width: 0;
}

.bridgeStatusCardHeader span span {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.bridgeRefreshButton {
  height: 30px;
  width: 30px;
}

.bridgeStatusMeta {
  gap: 8px;
  justify-content: space-between;
}

.bridgeStatusCard p {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
  margin: 0;
}

.bridgeAgentRows {
  display: grid;
  gap: 6px;
}

.bridgeAgentRow {
  background: #f8fbff;
  border: 1px solid #e3eaf2;
  border-radius: 7px;
  justify-content: space-between;
  min-height: 34px;
  padding: 0 8px;
}
```

Remove the mobile rules for `.bridgeStatusToggle`, `.bridgeStatusCards:not(.open)`, and `.bridgeStatusCards.open`.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```powershell
npm.cmd run test
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add app/globals.css tests/layout-css.test.ts
git commit -m "Embed bridge status styling in setup panel"
```

Use Lore trailers and include `Co-authored-by: OmX <omx@oh-my-codex.dev>`.

## Task 4: Full Verification and Merge

- [ ] **Step 1: Run typecheck**

Run:

```powershell
npm.cmd run typecheck
```

Expected: exits 0.

- [ ] **Step 2: Run lint**

Run:

```powershell
npm.cmd run lint
```

Expected: exits 0.

- [ ] **Step 3: Run tests**

Run:

```powershell
npm.cmd run test
```

Expected: exits 0.

- [ ] **Step 4: Run production build**

Run:

```powershell
npm.cmd run build
```

Expected: exits 0.

- [ ] **Step 5: Merge to main**

If using a feature branch:

```powershell
git switch main
git merge --ff-only <feature-branch>
```

Expected: fast-forward merge succeeds.

- [ ] **Step 6: Final test on main**

Run:

```powershell
npm.cmd run test
```

Expected: exits 0.

## Self-Review

- Spec coverage: Tasks cover registered URL filtering, safe `urlHost`, removing A2A/manual cards, left-panel placement, non-floating CSS, empty state, and verification.
- Placeholder scan: The plan contains no unresolved marker words or unspecified implementation steps.
- Type consistency: `BridgeId`, `BridgeHealth`, endpoint response, and UI bridge mapping all use only `codex-bridge` and `openclaw-bridge`.
