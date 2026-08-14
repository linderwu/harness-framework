# Registered Bridge Cards Placement Design

## Goal

Move bridge connection cards into the left blue setup panel and show only bridges that have a registered HTTP bridge URL.

## Current Behavior

The dashboard currently renders `BridgeStatusPanel` as a fixed bottom-right overlay. It uses hard-coded bridge definitions for:

- `Codex Bridge`
- `OpenClaw Bridge`
- `OpenClaw A2A`
- `Manual / Simulated`

The health endpoint reads bridge settings server-side from environment variables. The browser calls `/api/agent-health`; it does not read environment variables directly.

For HTTP bridges, `/api/agent-health` currently reads:

- `CODEX_BRIDGE_URL`
- `CODEX_BRIDGE_TOKEN`
- `OPENCLAW_BRIDGE_URL`
- `OPENCLAW_BRIDGE_TOKEN`

It then calls `<bridge-url>/health` from the server. Tokens are only used server-side in the `Authorization` header.

## Chosen Behavior

Render bridge cards inside the left blue `composePanel`, immediately below the `Create Project`, `Stop Stage`, and `Cancel Run` action row.

Display cards by registered bridge URL only:

- Show `Codex Bridge` only when `CODEX_BRIDGE_URL` is configured.
- Show `OpenClaw Bridge` only when `OPENCLAW_BRIDGE_URL` is configured.
- Do not show `OpenClaw A2A`.
- Do not show `Manual / Simulated`.
- Do not show unconfigured bridges as `not configured`.

If neither URL is configured, show a compact empty state in the same location: `No bridge URLs registered`.

## Data Flow

`/api/agent-health` should become the source of truth for which bridge cards exist.

The endpoint returns only configured HTTP bridge records:

```ts
interface AgentHealthResponse {
  checkedAt: string
  bridges: BridgeHealth[]
}

interface BridgeHealth {
  id: "codex-bridge" | "openclaw-bridge"
  label: string
  status: "online" | "offline"
  urlHost: string
  protocolVersion?: string
  capabilities?: string[]
  message?: string
}
```

`urlHost` should be derived server-side from the configured URL hostname. Do not return the full URL or token.

The client should map agent rows from the bridge id:

- `codex-bridge` contains `codex`.
- `openclaw-bridge` contains OpenClaw agents.

Agent rows continue to show selected-run activity when available, otherwise `idle`.

## Layout

Desktop and mobile:

- The bridge panel is part of the left setup panel, not a viewport overlay.
- It appears below the action buttons and above mutation errors.
- Cards are always visible in that panel; no floating toggle is needed.
- The panel scrolls naturally with the compose panel if content overflows.

## Error Handling

If a configured bridge health request fails, show its card as `offline`.

If `/api/agent-health` itself fails, keep the last known cards visible if available and mark them offline after two consecutive failed polls.

If no bridge URLs are configured, show the compact empty state rather than rendering offline cards.

## Testing

Add or update tests to assert:

- `BridgeStatusPanel` is rendered inside `composePanel` after the action row.
- The dashboard no longer renders the bridge panel as a fixed bottom-right overlay.
- The health endpoint only includes `CODEX_BRIDGE_URL` and `OPENCLAW_BRIDGE_URL` bridge sources.
- `OpenClaw A2A` and `Manual / Simulated` are not part of bridge card definitions.
- CSS no longer fixes `.bridgeStatusPanel` to the viewport.

Run:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
npm.cmd run build
```

## Open Decisions

None. The placement and registered-URL-only rule were approved by the user.
