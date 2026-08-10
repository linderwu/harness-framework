# Bridge Agent Status Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bottom-right bridge health panel that groups agent connection state by bridge and shows each bridge's agents inside its card.

**Architecture:** Add a small server-side health layer at `/api/agent-health` that reports bridge-level records. The client polls that endpoint from a focused `BridgeStatusPanel`, derives client-only states such as `checking` and `stale`, and merges the selected run's agent activity into bridge-grouped cards.

**Tech Stack:** Next.js route handlers, React client components inside `components/harness-dashboard.tsx`, existing `agentProfiles` metadata, existing `AgentRun` workflow state, Node test runner structure tests, CSS in `app/globals.css`.

---

## File Structure

- Create: `app/api/agent-health/route.ts`
  - Owns dashboard-facing bridge health checks and returns bridge-level JSON.
- Modify: `components/harness-dashboard.tsx`
  - Adds bridge status types/constants, polling panel, bridge card renderer, and agent row renderer.
  - Wires `selectedRun` into the bottom-right panel from the main dashboard.
- Modify: `app/globals.css`
  - Adds fixed desktop panel styling and collapsed mobile sheet/button styling.
- Modify: `tests/harness-dashboard-structure.test.ts`
  - Locks the bridge-grouped component structure and polling thresholds.
- Modify: `tests/layout-css.test.ts`
  - Locks the fixed bottom-right desktop placement and mobile collapse rules.
- Modify: `package.json`
  - Add `app/api/agent-health/route.ts` to the test compile command if the route imports types or helpers that need TypeScript coverage in the existing test script.

## Task 1: Add Bridge Health Endpoint

**Files:**
- Create: `app/api/agent-health/route.ts`
- Test: `tests/harness-dashboard-structure.test.ts`

- [ ] **Step 1: Write the failing structure test**

Add this test to `tests/harness-dashboard-structure.test.ts`:

```ts
test("dashboard has a bridge health endpoint contract", () => {
  const route = readFileSync("app/api/agent-health/route.ts", "utf8")

  assert.match(route, /export async function GET\(\)/)
  assert.match(route, /codex-bridge/)
  assert.match(route, /openclaw-bridge/)
  assert.match(route, /openclaw-a2a/)
  assert.match(route, /not_configured/)
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npm run test
```

Expected: FAIL because `app/api/agent-health/route.ts` does not exist.

- [ ] **Step 3: Implement the endpoint**

Create `app/api/agent-health/route.ts`:

```ts
import { NextResponse } from "next/server"

type BridgeHealthStatus = "online" | "offline" | "not_configured"

interface BridgeHealth {
  id: "codex-bridge" | "openclaw-bridge" | "openclaw-a2a" | "manual"
  label: string
  status: BridgeHealthStatus
  protocolVersion?: string
  capabilities?: string[]
  message?: string
}

const healthTimeoutMs = 2500

export async function GET() {
  const bridges = await Promise.all([
    checkHttpBridge({
      id: "codex-bridge",
      label: "Codex Bridge",
      url: process.env.CODEX_BRIDGE_URL,
      token: process.env.CODEX_BRIDGE_TOKEN
    }),
    checkHttpBridge({
      id: "openclaw-bridge",
      label: "OpenClaw Bridge",
      url: process.env.OPENCLAW_BRIDGE_URL,
      token: process.env.OPENCLAW_BRIDGE_TOKEN
    }),
    checkCommandBridge({
      id: "openclaw-a2a",
      label: "OpenClaw A2A",
      command: process.env.OPENCLAW_A2A_COMMAND
    }),
    {
      id: "manual",
      label: "Manual / Simulated",
      status: "online",
      message: "Manual and simulated runs do not require a network bridge."
    } satisfies BridgeHealth
  ])

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    bridges
  })
}

async function checkHttpBridge(input: {
  id: BridgeHealth["id"]
  label: string
  url?: string
  token?: string
}): Promise<BridgeHealth> {
  if (!input.url) {
    return {
      id: input.id,
      label: input.label,
      status: "not_configured",
      message: "Bridge URL is not configured."
    }
  }

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
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function checkCommandBridge(input: {
  id: BridgeHealth["id"]
  label: string
  command?: string
}): BridgeHealth {
  if (!input.command) {
    return {
      id: input.id,
      label: input.label,
      status: "not_configured",
      message: "A2A command is not configured."
    }
  }

  return {
    id: input.id,
    label: input.label,
    status: "online",
    message: "A2A command is configured."
  }
}

function normalizeUrl(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```powershell
npm run test
```

Expected: PASS for the new endpoint contract test.

- [ ] **Step 5: Commit the endpoint**

Run:

```powershell
git add app/api/agent-health/route.ts tests/harness-dashboard-structure.test.ts
git commit -m "Expose bridge-level dashboard health"
```

Use the repository Lore commit trailers and include the OmX co-author trailer.

## Task 2: Add Bridge Status Panel Component

**Files:**
- Modify: `components/harness-dashboard.tsx`
- Test: `tests/harness-dashboard-structure.test.ts`

- [ ] **Step 1: Write the failing structure tests**

Add these tests to `tests/harness-dashboard-structure.test.ts`:

```ts
test("dashboard renders the bridge status panel with the selected run", () => {
  assert.match(dashboard, /<BridgeStatusPanel\s+run=\{selectedRun\}/)
  assert.match(dashboard, /function BridgeStatusPanel\(/)
})

test("bridge status panel groups agents by bridge", () => {
  const panel = functionBody("BridgeStatusPanel")

  assert.match(panel, /bridgeDefinitions\.map/)
  assert.match(panel, /BridgeStatusCard/)
  assert.doesNotMatch(panel, /agentProfiles\.map\(\(agent\) =>\s*<BridgeStatusCard/)
})

test("bridge status polling and stale thresholds match the accepted design", () => {
  assert.match(dashboard, /const bridgeHealthPollIntervalMs = 10_000/)
  assert.match(dashboard, /const bridgeHealthStaleAfterMs = 30_000/)
  assert.match(dashboard, /const bridgeOfflineFailureThreshold = 2/)
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npm run test
```

Expected: FAIL because `BridgeStatusPanel` and timing constants do not exist.

- [ ] **Step 3: Add imports and constants**

Modify the top of `components/harness-dashboard.tsx`:

```ts
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardList,
  FileUp,
  FolderUp,
  GitBranch,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Square,
  SlidersHorizontal,
  ShieldCheck,
  Trash2,
  UserCheck,
  Wifi,
  WifiOff,
  X
} from "lucide-react"
```

Add near the existing constants:

```ts
const bridgeHealthPollIntervalMs = 10_000
const bridgeHealthStaleAfterMs = 30_000
const bridgeOfflineFailureThreshold = 2

type BridgeHealthStatus = "online" | "offline" | "not_configured"
type BridgePanelStatus =
  | BridgeHealthStatus
  | "checking"
  | "stale"

interface BridgeHealth {
  id: BridgeId
  label: string
  status: BridgeHealthStatus
  protocolVersion?: string
  capabilities?: string[]
  message?: string
}

interface AgentHealthResponse {
  checkedAt: string
  bridges: BridgeHealth[]
}

type BridgeId =
  | "codex-bridge"
  | "openclaw-bridge"
  | "openclaw-a2a"
  | "manual"

interface BridgeDefinition {
  id: BridgeId
  label: string
  agents: AgentKind[]
}

const bridgeDefinitions: BridgeDefinition[] = [
  {
    id: "codex-bridge",
    label: "Codex Bridge",
    agents: ["codex"]
  },
  {
    id: "openclaw-bridge",
    label: "OpenClaw Bridge",
    agents: []
  },
  {
    id: "openclaw-a2a",
    label: "OpenClaw A2A",
    agents: ["openclaw.rowlet", "openclaw.roaringmoon", "openclaw.charizard"]
  },
  {
    id: "manual",
    label: "Manual / Simulated",
    agents: ["manual"]
  }
]
```

- [ ] **Step 4: Render the panel from the dashboard**

Add this immediately before the closing `</main>` in `HarnessDashboard`:

```tsx
      <BridgeStatusPanel run={selectedRun} />
```

- [ ] **Step 5: Add the panel and card components**

Add these functions before `AgentSelect`:

```tsx
function BridgeStatusPanel({ run }: { run?: WorkflowRun }) {
  const [health, setHealth] = useState<Record<BridgeId, BridgeHealth>>({})
  const [isChecking, setIsChecking] = useState(false)
  const [failureCount, setFailureCount] = useState(0)
  const [lastSuccessAt, setLastSuccessAt] = useState<string | undefined>()
  const [isOpen, setIsOpen] = useState(false)

  async function refreshBridgeHealth() {
    setIsChecking(true)

    try {
      const response = await fetch("/api/agent-health", { cache: "no-store" })
      const data = (await response.json()) as AgentHealthResponse

      if (!response.ok) {
        throw new Error("Bridge health request failed")
      }

      setHealth(
        Object.fromEntries(
          data.bridges.map((bridge) => [bridge.id, bridge])
        ) as Record<BridgeId, BridgeHealth>
      )
      setLastSuccessAt(data.checkedAt)
      setFailureCount(0)
    } catch {
      setFailureCount((current) => current + 1)
    } finally {
      setIsChecking(false)
    }
  }

  useLayoutEffect(() => {
    void refreshBridgeHealth()
    const intervalId = window.setInterval(
      refreshBridgeHealth,
      bridgeHealthPollIntervalMs
    )

    return () => window.clearInterval(intervalId)
  }, [])

  const isStale =
    lastSuccessAt &&
    Date.now() - new Date(lastSuccessAt).getTime() > bridgeHealthStaleAfterMs
  const panelStatus = getAggregateBridgeStatus({
    health,
    failureCount,
    isChecking,
    isStale: Boolean(isStale)
  })

  return (
    <aside className="bridgeStatusPanel" aria-label="Agent bridge status">
      <button
        className={`bridgeStatusToggle ${panelStatus}`}
        onClick={() => setIsOpen((current) => !current)}
        title="Agent bridge status"
        type="button"
      >
        {panelStatus === "online" ? <Wifi size={17} /> : <WifiOff size={17} />}
        <span>Bridges</span>
      </button>

      <div className={isOpen ? "bridgeStatusCards open" : "bridgeStatusCards"}>
        {bridgeDefinitions.map((bridge) => (
          <BridgeStatusCard
            bridge={bridge}
            failureCount={failureCount}
            health={health[bridge.id]}
            isChecking={isChecking}
            isStale={Boolean(isStale)}
            key={bridge.id}
            lastSuccessAt={lastSuccessAt}
            run={run}
            onRefresh={refreshBridgeHealth}
          />
        ))}
      </div>
    </aside>
  )
}

function BridgeStatusCard({
  bridge,
  failureCount,
  health,
  isChecking,
  isStale,
  lastSuccessAt,
  run,
  onRefresh
}: {
  bridge: BridgeDefinition
  failureCount: number
  health?: BridgeHealth
  isChecking: boolean
  isStale: boolean
  lastSuccessAt?: string
  run?: WorkflowRun
  onRefresh: () => void
}) {
  const status = getBridgePanelStatus({
    failureCount,
    health,
    isChecking,
    isStale
  })

  return (
    <article className={`bridgeStatusCard ${status}`}>
      <div className="bridgeStatusCardHeader">
        <span>
          <Server size={16} />
          <strong>{health?.label ?? bridge.label}</strong>
        </span>
        <button
          className="iconButton bridgeRefreshButton"
          onClick={onRefresh}
          title="Refresh bridge health"
          type="button"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="bridgeStatusMeta">
        <StatusPill status={status === "not_configured" ? "stopped" : status} />
        <small>{formatBridgeCheckedAt(lastSuccessAt)}</small>
      </div>
      {health?.message ? <p>{health.message}</p> : null}
      <div className="bridgeAgentRows">
        {bridge.agents.map((agent) => (
          <AgentBridgeRow agent={agent} key={agent} run={run} />
        ))}
      </div>
    </article>
  )
}

function AgentBridgeRow({
  agent,
  run
}: {
  agent: AgentKind
  run?: WorkflowRun
}) {
  const latestAgentRun = [...(run?.agentRuns ?? [])]
    .reverse()
    .find((agentRun) => agentRun.agent === agent)
  const profile = agentProfiles.find((candidate) => candidate.id === agent)

  if (!profile) {
    return null
  }

  return (
    <div className="bridgeAgentRow">
      <AgentOptionLabel agent={profile} />
      <small>{latestAgentRun?.status ?? "idle"}</small>
    </div>
  )
}
```

- [ ] **Step 6: Add status helpers**

Add these functions before `StatusPill`:

```ts
function getBridgePanelStatus({
  failureCount,
  health,
  isChecking,
  isStale
}: {
  failureCount: number
  health?: BridgeHealth
  isChecking: boolean
  isStale: boolean
}): BridgePanelStatus {
  if (isChecking && !health) {
    return "checking"
  }

  if (isStale && health?.status === "online") {
    return "stale"
  }

  if (failureCount >= bridgeOfflineFailureThreshold && !health) {
    return "offline"
  }

  return health?.status ?? "checking"
}

function getAggregateBridgeStatus({
  failureCount,
  health,
  isChecking,
  isStale
}: {
  failureCount: number
  health: Record<BridgeId, BridgeHealth>
  isChecking: boolean
  isStale: boolean
}): BridgePanelStatus {
  const statuses = bridgeDefinitions.map((bridge) =>
    getBridgePanelStatus({
      failureCount,
      health: health[bridge.id],
      isChecking,
      isStale
    })
  )

  if (statuses.some((status) => status === "online")) {
    return "online"
  }

  if (statuses.some((status) => status === "checking")) {
    return "checking"
  }

  if (failureCount >= bridgeOfflineFailureThreshold) {
    return "offline"
  }

  return statuses[0] ?? "checking"
}

function formatBridgeCheckedAt(value?: string) {
  if (!value) {
    return "not checked"
  }

  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000)
  )

  return `${seconds}s ago`
}
```

- [ ] **Step 7: Run the focused test to verify it passes**

Run:

```powershell
npm run test
```

Expected: PASS for the new structure tests.

- [ ] **Step 8: Commit the panel component**

Run:

```powershell
git add components/harness-dashboard.tsx tests/harness-dashboard-structure.test.ts
git commit -m "Group agent status by bridge"
```

Use the repository Lore commit trailers and include the OmX co-author trailer.

## Task 3: Style the Bottom-Right Cards

**Files:**
- Modify: `app/globals.css`
- Test: `tests/layout-css.test.ts`

- [ ] **Step 1: Write the failing CSS structure test**

Add this test to `tests/layout-css.test.ts`:

```ts
test("bridge status panel is fixed on desktop and collapses on mobile", () => {
  const panelRule = ruleBody(/\.bridgeStatusPanel/, ".bridgeStatusPanel")
  const cardStackRule = ruleBody(/\.bridgeStatusCards/, ".bridgeStatusCards")
  const mobileRule = css.match(
    /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/
  )

  assert.match(panelRule, /position:\s*fixed;/)
  assert.match(panelRule, /bottom:\s*18px;/)
  assert.match(panelRule, /right:\s*18px;/)
  assert.match(cardStackRule, /width:\s*min\(360px, calc\(100vw - 36px\)\);/)
  assert.ok(mobileRule, "Expected mobile media query to exist")
  assert.match(mobileRule[1], /\.bridgeStatusCards:not\(\.open\)/)
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npm run test
```

Expected: FAIL because bridge status CSS does not exist.

- [ ] **Step 3: Add desktop styles**

Add this CSS near the other component styles in `app/globals.css`:

```css
.bridgeStatusPanel {
  bottom: 18px;
  display: grid;
  gap: 10px;
  justify-items: end;
  pointer-events: none;
  position: fixed;
  right: 18px;
  z-index: 15;
}

.bridgeStatusToggle,
.bridgeStatusCards {
  pointer-events: auto;
}

.bridgeStatusToggle {
  align-items: center;
  background: rgba(15, 23, 42, 0.92);
  border: 1px solid rgba(148, 163, 184, 0.38);
  border-radius: 8px;
  color: #f8fbff;
  display: none;
  font-weight: 800;
  gap: 8px;
  min-height: 42px;
  padding: 0 12px;
}

.bridgeStatusCards {
  display: grid;
  gap: 8px;
  width: min(360px, calc(100vw - 36px));
}

.bridgeStatusCard {
  background: rgba(251, 253, 255, 0.96);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  box-shadow: 0 16px 34px rgba(15, 23, 42, 0.16);
  display: grid;
  gap: 8px;
  padding: 11px;
}

.bridgeStatusCard.online {
  border-color: rgba(15, 118, 110, 0.38);
}

.bridgeStatusCard.offline,
.bridgeStatusCard.stale {
  border-color: rgba(220, 38, 38, 0.38);
}

.bridgeStatusCard.checking,
.bridgeStatusCard.not_configured {
  border-color: rgba(202, 138, 4, 0.38);
}

.bridgeStatusCardHeader,
.bridgeStatusCardHeader span,
.bridgeStatusMeta,
.bridgeAgentRow {
  align-items: center;
  display: flex;
}

.bridgeStatusCardHeader {
  justify-content: space-between;
}

.bridgeStatusCardHeader span {
  gap: 7px;
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

- [ ] **Step 4: Add mobile collapse styles**

Add this inside the existing `@media (max-width: 640px)` block:

```css
  .bridgeStatusToggle {
    display: inline-flex;
  }

  .bridgeStatusCards:not(.open) {
    display: none;
  }

  .bridgeStatusCards.open {
    max-height: min(70vh, 520px);
    overflow: auto;
  }
```

- [ ] **Step 5: Run the CSS test to verify it passes**

Run:

```powershell
npm run test
```

Expected: PASS for the bridge status layout test.

- [ ] **Step 6: Commit styles**

Run:

```powershell
git add app/globals.css tests/layout-css.test.ts
git commit -m "Anchor bridge status cards in the viewport"
```

Use the repository Lore commit trailers and include the OmX co-author trailer.

## Task 4: Full Verification and Release

**Files:**
- Modify only if verification reveals failures in files touched by Tasks 1-3.

- [ ] **Step 1: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: command exits 0.

- [ ] **Step 2: Run lint**

Run:

```powershell
npm run lint
```

Expected: command exits 0.

- [ ] **Step 3: Run tests**

Run:

```powershell
npm run test
```

Expected: command exits 0.

- [ ] **Step 4: Run production build**

Run:

```powershell
npm run build
```

Expected: command exits 0.

- [ ] **Step 5: Inspect git state**

Run:

```powershell
git status --short --branch
```

Expected: branch is `main`; only unrelated pre-existing files such as `.env.example` or `.omx/*` may remain unstaged.

- [ ] **Step 6: Merge to main**

If implementation happened on a feature branch, run:

```powershell
git switch main
git merge --ff-only <feature-branch>
```

Expected: fast-forward merge succeeds.

If implementation happened directly on `main`, record that no merge command is needed because the branch is already `main`.

- [ ] **Step 7: Push main**

Run:

```powershell
git push origin main
```

Expected: push succeeds and `main` is no longer ahead of `origin/main`.

## Self-Review

- Spec coverage: Tasks cover the `/api/agent-health` endpoint, bridge-grouped cards, 10-second polling, 30-second stale threshold, two-failure offline behavior, manual refresh, desktop bottom-right placement, mobile collapse, and tests.
- Placeholder scan: The plan contains no unresolved marker words or unspecified implementation steps.
- Type consistency: `BridgeId`, `BridgeHealth`, `AgentHealthResponse`, and `BridgePanelStatus` are introduced before they are used by the panel components and helpers.
