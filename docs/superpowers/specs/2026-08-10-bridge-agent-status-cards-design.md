# Bridge Agent Status Cards Design

## Goal

Show current agent connection health in the bottom-right corner of the dashboard, grouped by bridge. Each bridge owns one status card, and each card lists the agents that use that bridge.

## Chosen Approach

Use one fixed bottom-right status panel made of bridge cards.

Each bridge card shows:

- Bridge label, such as `Codex Bridge`, `OpenClaw Bridge`, `OpenClaw A2A`, or `Manual / Simulated`.
- Health state: `checking`, `online`, `offline`, `not configured`, or `stale`.
- Last successful update time.
- A compact manual refresh button.
- Child rows for each agent attached to that bridge.

Each agent row shows:

- Agent label.
- Latest run state from the selected workflow run when available.
- `idle` when the agent has no current or recent activity in the selected run.
- Optional source/status message when useful and short enough to fit.

## Health Check Behavior

The dashboard checks bridge health immediately when the page loads, then polls every 10 seconds.

Status rules:

- `checking`: a health request is currently in flight.
- `online`: the latest health request succeeded.
- `offline`: two consecutive health checks failed.
- `not configured`: the server reports no URL or command is configured for that bridge.
- `stale`: no successful health update has happened for more than 30 seconds.

The panel includes a manual refresh control so the user can re-check bridge status without waiting for the next poll.

## Data Flow

Add or complete a dashboard-facing health endpoint at `/api/agent-health`.

The endpoint returns bridge-level records, not one record per agent. The client maps agents into bridge cards using local agent profiles and bridge source rules.

Expected response shape:

```ts
interface AgentHealthResponse {
  checkedAt: string
  bridges: BridgeHealth[]
}

interface BridgeHealth {
  id: "codex-bridge" | "openclaw-bridge" | "openclaw-a2a" | "manual"
  label: string
  status: "online" | "offline" | "not_configured"
  protocolVersion?: string
  capabilities?: string[]
  message?: string
}
```

Client-only states such as `checking` and `stale` are derived in the React component.

## Layout

Desktop:

- Fixed to the bottom-right of the viewport.
- Width around 320-380px.
- Cards stack vertically with tight spacing.
- The panel should avoid covering dialogs and should sit below modal overlays in z-index.

Mobile:

- Collapse into a bottom-right status button.
- Tapping the button opens the bridge cards in a compact sheet.

## Component Boundaries

Add focused helpers rather than expanding `RunDetail`.

Proposed components:

- `BridgeStatusPanel`: owns polling, manual refresh, and panel state.
- `BridgeStatusCard`: renders one bridge.
- `AgentBridgeRow`: renders one agent within a bridge.

The existing `AgentIcon`, `getAgentLabel`, and `agentProfiles` should be reused.

## Error Handling

If `/api/agent-health` fails, keep the latest known bridge data visible and mark bridges offline only after the second consecutive failed check.

If there is no selected run, agent rows still render from configured agent profiles and show `idle`.

If a bridge is not configured, the card should clearly say `not configured` instead of looking like a network failure.

## Testing

Add focused structure tests that assert:

- The dashboard renders `BridgeStatusPanel`.
- Bridge cards are grouped by bridge, not by individual agent.
- The polling interval is 10 seconds.
- The stale threshold is 30 seconds.

Run:

```powershell
npm run typecheck
npm run lint
npm run test
```

## Open Decisions

None. The user selected bridge-grouped cards and accepted a 10-second health check interval.
