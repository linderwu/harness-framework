# Task Monitoring and Bridge Connections Separation

## Context

The right-side monitoring rail currently renders `Bridge Connections` as the last collapsible `MonitoringSection` inside `TaskStatusSidebar`. The rail's `isMonitoringExpanded` state controls the entire sidebar, so collapsing Task monitoring also hides Bridge Connections.

## Goal

Keep the existing three-column workspace while making `Task monitoring` and `Bridge Connections` independent panels. Each panel must have its own expand/collapse control and state. Collapsing one panel must leave the other panel visible and in its previous state.

## Non-goals

- No drag-to-resize behavior.
- No changes to bridge health polling, quota polling, bridge agent rendering, or profile updates.
- No redesign of the main conversation workspace or left navigation rail.

## Design

`TaskStatusSidebar` remains the right-side panel container. Its content becomes two sibling panels:

1. `Task monitoring` keeps the existing `isMonitoringExpanded` and `onExpandedChange` contract. Its current task, agent role status, and governance sections remain unchanged.
2. `Bridge Connections` moves out of `MonitoringSection` into a dedicated `BridgeConnectionsPanel`. The new panel owns an `isExpanded` state, initially `true`, and renders the existing `bridgeConnections` node when expanded.

The right-side grid column keeps its current width and responsive behavior. Panel collapse hides only the panel body; it does not collapse the entire grid column or affect the sibling panel. The no-active-task branch should use the same two-panel structure so the behavior is consistent regardless of whether a run is selected.

Both panel controls retain accessible `aria-expanded` and descriptive `aria-label` values, and remain keyboard operable.

## Data flow and failure behavior

The parent continues to pass the existing `BridgeStatusPanel` node into `TaskStatusSidebar`. Separating the panel boundary does not change the bridge data flow. Existing empty and failure states remain visible inside the Bridge Connections panel, including `No bridge URLs registered`; refresh and quota behavior remain unchanged.

On narrow screens, the existing monitoring drawer remains the entry point. The two panel states remain independent inside that drawer.

## Verification

- Update structure tests to assert that Task monitoring and Bridge Connections are sibling panels with independent controls/state.
- Update layout tests so the right rail no longer depends on one shared collapse state and preserves the existing non-nested-scrolling bridge layout.
- Run the relevant test suite.
- Run `npm run typecheck`.
- Run `npm run build`.

## Acceptance criteria

- Task monitoring can be expanded or collapsed without changing Bridge Connections visibility or expansion state.
- Bridge Connections can be expanded or collapsed without changing Task monitoring visibility or expansion state.
- The right rail remains within the existing workspace layout on desktop and mobile.
- Existing bridge status behavior and accessible controls continue to work.
- All verification commands complete successfully.
