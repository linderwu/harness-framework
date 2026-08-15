# Jormungand Task Conversation UI Design

**Date:** 2026-08-15  
**Status:** Approved for implementation handoff  
**Audience:** Codex and other development sessions implementing the Jormungand dashboard UI  
**Normative HTML reference:** [2026-08-15-jormungand-task-conversation-ui-reference.html](./2026-08-15-jormungand-task-conversation-ui-reference.html)

## 1. Goal

Redesign the Jormungand dashboard around one primary task conversation while preserving project navigation, agent role visibility, workflow status, and bridge health. Global mode becomes the topmost full-width application control and is rendered as a segmented Jormungand dragon.

The implementation must let the operator:

- Select one of nine Global modes from the dragon body.
- Read important responses from the selected workflow run in the largest workspace area.
- Send a message to an allowed agent from the conversation composer.
- Inspect project/run navigation on the left.
- Inspect task, agent, governance, and bridge state on the right.
- Collapse either side rail or individual right-side sections to preserve conversation width.

## 2. Source of Truth and Superseded Decisions

This document and its adjacent HTML file are the source of truth for this UI slice.

It supersedes these earlier layout decisions:

- [2026-08-14-global-mode-dragon-body-design.md](./2026-08-14-global-mode-dragon-body-design.md): Global mode moves out of the compose panel to the top of the complete application. The old faint cyan spine and mode edge controls are removed. The dragon head is decorative and does not own a task.
- [2026-08-10-registered-bridge-cards-placement-design.md](./2026-08-10-registered-bridge-cards-placement-design.md): Bridge Connections moves from the left compose panel into the right collapsible monitoring rail.
- [2026-08-10-bridge-agent-status-cards-design.md](./2026-08-10-bridge-agent-status-cards-design.md): Bridge Connections is not a fixed viewport overlay. Agent role cards and bridge cards are separate sections in the right rail.

Unchanged behavior from the bridge specifications remains binding:

- `/api/agent-health` is the source of truth for bridge cards.
- Only registered HTTP bridges returned by that endpoint are displayed.
- Full bridge URLs and tokens are never exposed to the browser.
- Health polling, stale handling, and failure behavior remain data-layer concerns rather than being redefined by this visual specification.

## 3. Application Hierarchy

The desktop application is ordered as follows:

```text
GlobalModeDragonNav            full-width, topmost
ApplicationHeader             Jormungand identity, current mode, global actions
Workspace
├── ProjectRunRail            left, collapsible
├── TaskConversation          center, always primary
└── TaskMonitoringRail        right, collapsible
    ├── CurrentTaskSection
    ├── AgentRoleStatusSection
    ├── GovernanceSection
    └── BridgeConnectionsSection
```

No mode selector remains inside the left compose/project rail. Previous/next edge buttons are removed because the full Global mode navigator is authoritative.

## 4. Global Mode Dragon Navigation

### 4.1 Modes

Render these nine options in this order:

| Project type | Label | Icon |
|---|---|---|
| `research` | Research | `Search` |
| `development` | Development | `Code2` |
| `testing` | Testing | `CheckCheck` |
| `documentation` | Documentation | `BookOpenText` |
| `diagnosis` | Diagnosis | `Bug` |
| `decision` | Decision | `GitBranch` |
| `agent_task` | Agent Task | `Bot` |
| `hive_mission` | Hive Mission | `Network` |
| `arceus_maintenance` | Arceus Maintenance | `Wrench` |

The type additions may be implemented in a separate domain/workflow slice. The navigation component must consume the canonical project-type catalog rather than keeping a second list.

### 4.2 Dragon anatomy

- The head appears at the left of the body and is decorative only.
- The head contains no project type, button, click handler, tooltip, or selected state.
- Use only the approved head portion of the supplied Jormungand image; do not render the original circular segmented body.
- Each Global mode is one beveled, interlocking body segment.
- The final segment tapers into a tail-like point.
- Do not draw a faint horizontal spine or any parallel cyan connector lines behind the segments.
- Every segment always shows its icon centered both horizontally and vertically.

### 4.3 Visual states

Unselected segment:

- Icon remains visible.
- Icon uses a lighter, lower-emphasis color than the selected icon.
- Segment preserves enough border contrast to remain identifiable as one body section.
- Label is available through accessible name and tooltip; it need not occupy permanent body space.

Selected segment:

- Icon remains centered and becomes higher contrast.
- Icon may scale up slightly.
- Segment may rise or scale slightly but must remain visually connected to the body.
- Selection cannot rely on color alone; elevation/scale and `aria-pressed` also communicate state.

### 4.4 Interaction and accessibility

- Use native `button` elements for all nine task segments.
- Set `aria-label` to the mode label and `aria-pressed` to the selected state.
- Preserve visible keyboard focus.
- Minimum interactive target is 44 by 44 CSS pixels.
- Selecting a mode updates page accent, current-mode summary, creation action, and mode-specific agent rules.
- At narrow widths, keep one horizontal body and allow horizontal scrolling. Do not wrap the dragon into disconnected rows.

## 5. Application Header

The header sits immediately below Global mode and contains:

- Jormungand identity/mark.
- Current mode label and short description.
- Refresh action.
- Contextual create action.

The create label changes with mode:

- Hive Mission: `建立蜂群任務`.
- Arceus Maintenance: `建立維護任務`.
- Other modes: mode-specific create label.

## 6. Workspace Layout

### 6.1 Desktop

Use a three-column grid:

```text
ProjectRunRail | TaskConversation | TaskMonitoringRail
```

The center column receives the largest flexible share. Both side rails have usable expanded widths but can collapse to narrow icon rails. When either side closes, the center column immediately receives the released width. There is no horizontal overlay on top of the conversation.

### 6.2 Mobile

- Task Conversation renders first.
- Project/run navigation and task monitoring move below it or into accessible drawers.
- Global mode remains horizontally scrollable at the top.
- Composer fields stack without clipping.
- Side-rail collapse controls remain keyboard accessible.

### 6.3 Scrolling

- Use normal page/document vertical scrolling for the full dashboard.
- Do not introduce narrow nested scrolling inside Bridge Connections or Agent Role Status.
- Expanded right-side content may extend the page downward so the operator can scroll to see all cards.
- Collapsing sections restores a compact monitoring rail and keeps the conversation visually complete.

## 7. Left Project and Run Rail

Expanded state contains:

- Project creation control.
- Project list.
- Selected project indicator.
- Project-scoped workflow runs.
- Run status and stage summaries.

Collapsed state:

- Width becomes a narrow icon rail.
- Project/run content is hidden, not squeezed or truncated into unreadable text.
- The expand arrow points right, toward the center conversation.

Expanded rail control:

- Displays a small downward arrow.
- `aria-expanded="true"`.

Collapsed rail control:

- Displays a right-pointing inward arrow.
- `aria-expanded="false"`.

## 8. Primary Task Conversation

The conversation is bound to the selected workflow run and is always the largest functional surface.

### 8.1 Header

Show:

- Current task/run title.
- Short description such as `目前任務的重要回應`.
- Compact workflow progress indicator.

### 8.2 Important response feed

Display only task-relevant conversation entries:

- Operator messages.
- Final or important agent responses.
- Codex manager dispatch, retry, reassignment, stop, and completion summaries.
- Blocking findings and failure causes.
- Test and code-review conclusions.
- Approval requests and decisions.

Raw tool output, full logs, private reasoning, and verbose intermediate traces remain in artifacts or detail views.

Each visible entry identifies:

- Role/agent.
- Timestamp or relative time.
- Importance/status treatment.
- Message body.
- Optional references to artifacts, tasks, memories, or approval gates.

### 8.3 Composer

The composer stays at the bottom of the conversation and contains:

- Agent selector.
- Message input.
- Send button.
- Short routing/policy note.

Mode-specific routing:

- Agent Task sends directly to the selected permitted agent.
- Hive Mission defaults to Codex Manager. A message addressed to a worker is also recorded for and surfaced to Codex Manager.
- Arceus Maintenance fixes the selector to Codex and renders it disabled/read-only.
- Offline, disabled, or unauthorized agents cannot be selected.
- Messages never bypass workflow scope, budgets, or approval gates.

### 8.4 Empty, queued, and failure states

- No selected run: explain that a run must be selected or created.
- No conversation entries: retain the composer and show a compact empty state.
- Agent busy: persist the message and show `queued`.
- Running: show `running` without duplicating raw logs.
- Failed: keep the failed entry visible with a retry affordance when policy allows.
- Duplicate submission: suppress through the message idempotency key.

## 9. Right Task Monitoring Rail

The right rail is composed of independent collapsible sections. The entire rail can also collapse to a narrow icon rail.

Expanded rail control:

- Shows a small downward arrow.
- `aria-expanded="true"`.

Collapsed rail control:

- Shows a left-pointing arrow toward the center conversation.
- `aria-expanded="false"`.

Each expanded section header shows a downward arrow. Each collapsed section in the right rail shows a left-pointing inward arrow. Arrow direction is not decorative: it communicates the next spatial action.

Section open/closed state is presentation state. It may persist in browser storage but does not belong in workflow state or hive memory.

### 9.1 Current Task

Show status, workflow stage, consumed/maximum calls, and elapsed/maximum time. Do not invent metrics that are unavailable from the run.

### 9.2 Agent Role Status

Preserve one role status card per relevant agent. Each card shows:

- Agent icon and label.
- Stable role, such as Hive Manager, Builder, Researcher, Reviewer, or Tester.
- Availability/run state.
- Current assignment or `available`/`idle`.

Role identity and current run status are distinct fields. Do not infer a permanent role from a transient task title.

### 9.3 Governance

Show compact counts or status for memories used, artifacts, and pending approval. Each value links to its existing detail surface when available.

### 9.4 Bridge Connections

- Default state is collapsed to one section row.
- Clicking the row expands all currently registered bridge cards downward.
- Clicking again returns it to one row.
- Expanded header arrow points down.
- Collapsed header arrow points left, toward the conversation.
- Use normal page scrolling to inspect all cards.
- Do not give Bridge Connections its own internal scrollbar.

Each bridge card is sourced from `/api/agent-health` and shows only available response fields:

- Label.
- Online/offline state.
- Host label if provided safely by the server.
- Protocol version if provided.
- Last check or latency only when actually measured.
- Compact manual refresh action for the section.

Do not hard-code A2A or simulated bridge cards. Do not render unregistered bridge sources. Never expose credentials or a full secret-bearing URL.

## 10. Suggested Component Boundaries

The current `components/harness-dashboard.tsx` is already large. Implement this slice with focused components rather than expanding one monolith:

```text
components/
├── harness-dashboard.tsx             orchestration and shared selected state
├── global-mode-dragon-nav.tsx        decorative head and nine mode buttons
├── project-run-rail.tsx               project/run navigation and rail collapse
├── task-conversation.tsx              feed, progress, empty/error states
├── task-conversation-composer.tsx     agent routing and message submission
├── task-monitoring-rail.tsx           rail and section collapse state
├── agent-role-status-section.tsx      agent role cards
└── bridge-connections-section.tsx     health cards and refresh
```

This is a recommended boundary, not authorization for unrelated dashboard refactoring. Existing reusable agent icon/label helpers should be extracted only when needed by more than one new component.

## 11. Data Contracts

The UI depends on domain/API work defined by the broader Hive Mission and Arceus design. The UI implementation should introduce typed seams even if backend endpoints arrive in a later slice.

Conversation entry:

```ts
interface ConversationEntry {
  id: string
  workflowRunId: string
  taskId?: string
  role: "user" | "agent" | "manager" | "system"
  agentId?: AgentKind
  content: string
  importance: "normal" | "important" | "critical"
  status: "queued" | "running" | "completed" | "failed"
  replyToId?: string
  artifactIds: string[]
  memoryIds: string[]
  createdAt: string
}
```

Conversation API target:

```http
GET  /api/workflow-runs/:id/conversation
POST /api/workflow-runs/:id/conversation
```

The UI must not simulate successful dispatch in production. Until the endpoint exists, use an explicit unavailable/disabled state or test-injected data.

## 12. Styling Contract

- Preserve the existing navy/cyan Jormungand visual language.
- Keep typography compact and operational rather than decorative.
- Use cyan for active/selected state and muted light icon color for unselected mode icons.
- Keep every body-segment icon visible.
- Do not restore the faint horizontal cyan spine.
- Avoid nested rounded cards and excessive glow.
- Use border, icon, label, and elevation together so state is not color-only.
- Honor reduced-motion preferences for segment and rail transitions.

The approved reference HTML is normative for hierarchy, relative proportions, controls, collapse behavior, and interaction. Exact pixel values may adapt to existing CSS tokens and browser constraints.

## 13. Implementation Order

1. Extend project-type/domain support for Hive Mission and Arceus where not already available.
2. Extract and move Global mode into `GlobalModeDragonNav` at the top of the application.
3. Remove old compose-panel mode UI, previous/next edge controls, and cyan spine styling.
4. Establish the three-column workspace and collapsible rails.
5. Move project/run navigation into the left rail.
6. Add Task Conversation with typed data and disabled/unavailable backend fallback.
7. Add Agent Role Status and Governance sections.
8. Move Bridge Connections into the right collapsible section while preserving health semantics.
9. Add responsive behavior and accessibility states.
10. Run narrow tests first, then full verification.

## 14. Verification

Add or update focused tests for:

- Global mode renders before the application header and outside the compose panel.
- Exactly nine canonical mode buttons render when all nine project types exist.
- Dragon head is decorative and not a mode button.
- Every segment has a centered icon in selected and unselected states.
- No `.modeDock::before` or equivalent cyan spine is rendered.
- Selected mode has `aria-pressed="true"` and non-color visual differentiation.
- Previous/next edge mode controls are removed.
- Task Conversation is the largest desktop column and first mobile content area.
- Agent selector enforces Hive Mission and Arceus routing rules.
- Left and right rail controls update `aria-expanded` and release width to the conversation.
- Right-side section controls update `aria-expanded` and hide/show their section body.
- Expanded arrows point down; collapsed left rail points right; collapsed right rail/sections point left.
- Agent role cards preserve role and run status separately.
- Bridge Connections defaults collapsed, expands downward, and has no internal scrolling.
- Bridge cards come only from `/api/agent-health` response records.
- Existing project creation, stop, cancel, approval, and agent-health behavior remains intact.

Run from `repos/jormungand`:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
npm.cmd run build
```

Also perform browser checks at desktop, tablet, and mobile widths. Verify keyboard navigation, focus visibility, horizontal Global mode scrolling, both rail controls, every right-side accordion, Agent selector states, and normal page scrolling through expanded Bridge Connections.

## 15. Acceptance Criteria

- Global mode is the topmost full-width application surface.
- The approved standalone dragon head appears without owning a mode.
- Nine icon-bearing body segments render with no faint connector lines.
- Selected and unselected icons remain centered and visually distinct.
- The current task conversation is the largest workspace area.
- The operator can address an allowed agent from the composer.
- Left and right rails can each collapse to an inward-arrow icon rail.
- Right-side sections can independently expand and collapse.
- Expanded controls show downward arrows; collapsed controls point inward.
- Agent Role Status remains visible in the right monitoring rail when expanded.
- Bridge Connections defaults to one collapsed row and expands downward on demand.
- The full right rail is viewable through normal page scrolling.
- Existing workflow controls, bridge-health security, and approval behavior do not regress.

## 16. Non-Goals

- Implementing the Hive Memory backend in this UI slice.
- Replacing the bridge-health API contract.
- Rendering raw agent logs in the main conversation.
- Persisting presentation-only collapse state in workflow or hive memory.
- Allowing conversation messages to bypass workflow policy or approval gates.
- Refactoring unrelated dashboard behavior.

