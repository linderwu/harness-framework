# Project Popover Selector Design

## Purpose

Replace the always-expanded Projects list in the right workspace header with an informational project selector.

The selector should make it easier to choose among multiple projects without consuming the full right header area. It should also help the user understand which project was active recently and which run will be selected after switching projects.

## Approved Direction

Use an informational collapsed selector with an overlay popover.

The collapsed state shows the currently selected project, a composite status dot, and a compact activity summary. Opening the selector reveals a searchable, filterable project list sorted by recent activity.

This design intentionally keeps project selection separate from the planned left-sidebar run/task switcher. The right header answers "which project am I in?" while the future left-sidebar task switcher can answer "which execution task/run am I viewing?"

## Placement

The selector replaces the current right-side `Projects` panel inside the workspace header.

Existing layout intent remains:

- Left column: project creation and run controls.
- Right column: workspace area.
- Right workspace first row: project selector.
- Right workspace main row: selected project detail.

The selector stays in the current right header position and does not move into the left blue compose panel.

## Collapsed State

The collapsed selector is a clickable summary panel.

Example:

```text
Projects                                      v

* Jormungandr MVP
Development - failed - 3 minutes ago
```

Behavior and display rules:

- Keep the current `runsPanel` visual direction: light blue/green panel treatment, compact, and visually distinct from ordinary detail cards.
- Header row contains the GitBranch icon, `Projects`, and a chevron.
- Selected project row contains:
  - Composite status dot.
  - Project name.
  - Project type, composite status, and relative activity time.
- Long project names truncate with ellipsis.
- The panel height remains stable in the workspace header.
- If there are no projects, show `No projects yet`.
- The full activity timestamp is available through `title` or a tooltip.

## Popover

Opening the selector shows an overlay popover. The popover floats over the workspace detail and does not push layout content down.

Example:

```text
Search projects...

All | Active | Needs attention | Completed

Jormungandr MVP
Development - failed - 3 minutes ago
Latest run: failed - Plan

Website QA
Testing - active - 12 minutes ago
Latest run: running - Execute
```

Popover content:

- Search input.
- Segmented filter control:
  - `All`
  - `Active`
  - `Needs attention`
  - `Completed`
- Project options sorted by recent activity.
- Each option displays:
  - Project name.
  - Project type, composite status, and relative activity time.
  - Latest run summary: `Latest run: <status> - <stage>`.
  - `No runs yet` when a project has no runs.
- The currently selected project is highlighted.
- If filtering or searching returns no results, show:
  - `No projects found`
  - `Clear filters`
- The popover does not include a `Create Project` action because project creation already lives in the left compose panel.

## Selection Behavior

Selecting a project from the popover:

1. Sets `selectedProjectId` to that project.
2. Selects the project's most recently updated run.
3. Sets `selectedRunId` to `undefined` if the project has no runs.
4. Closes the popover.

This replaces the current first-match behavior with latest-activity behavior. Switching projects should select the same run that made the project sort as recently active.

## Recent Activity

For each project:

```text
projectRuns = runs.filter(run.projectId === project.id)
latestRun = projectRuns sorted by run.updatedAt descending, first item
activityAt = latestRun?.updatedAt ?? project.updatedAt
```

Sorting:

```text
activityAt newest first
invalid or missing activityAt last
```

If the selected project is missing or deleted, the fallback selected project should be the most recently active project, not the first project in raw array order.

## Composite Status

The selector status should combine project status and run status so the collapsed panel can signal whether something needs attention.

Priority:

```text
Needs attention > Running > Active > Done
```

Status groups:

- Needs attention:
  - `waiting_for_approval`
  - `failed`
- Running:
  - `running`
- Active:
  - `pending`
  - `stopped`
  - project status `active`
  - project status `waiting_for_approval`
  - project status `stopped`
- Done:
  - `completed`
  - `cancelled`

If any run in a project is waiting for approval or failed, that project should surface as needs attention even when the project itself is still active.

## Filter Semantics

`All` shows every project.

`Needs attention` shows projects whose composite status is needs attention.

`Active` shows projects whose composite status is running or active.

`Completed` shows projects whose composite status is done.

The filters are intentionally coarse. They help the user navigate without exposing every low-level workflow status in the selector.

## Search Semantics

Search is case-insensitive and matches:

- `project.name`
- `project.repository`
- Project type label, such as `Development`, `Research`, or `Testing`

Search and filter combine with AND semantics.

## Time Display

Collapsed state and popover options show relative time:

```text
3 minutes ago
2 hours ago
yesterday
```

Full time is available through `title` or tooltip:

```text
2026-08-10 14:32
```

If the date cannot be parsed, display `Unknown activity` and sort that project last.

## Component Boundaries

Recommended components and helpers:

- `ProjectSelector`
  - Owns collapsed summary, popover open state, search state, filter state, and selection callbacks.
- `ProjectOption`
  - Renders a single project option inside the popover.
- `buildProjectSelectorItems(projects, runs)`
  - Aggregates project and run data into selector view models.
- `getProjectCompositeStatus(project, projectRuns)`
  - Computes status group, status label, and dot variant.
- `formatRelativeActivityTime(activityAt)`
  - Formats relative time for scanning.
- `formatAbsoluteActivityTime(activityAt)`
  - Formats precise tooltip text.

These helpers should keep `HarnessDashboard` from absorbing more selector-specific logic.

## Edge Cases

- No projects:
  - Collapsed selector displays `No projects yet`.
  - Popover may remain closed or show the same empty state.
- Project without runs:
  - Activity uses `project.updatedAt`.
  - Latest run line says `No runs yet`.
  - Selecting it clears `selectedRunId`.
- No search/filter results:
  - Show `No projects found`.
  - Show `Clear filters`.
- Missing selected project:
  - Fallback to most recently active project.
- Invalid activity timestamps:
  - Show `Unknown activity`.
  - Sort last.

## Testing

Add focused tests for the selector data and rendering behavior:

- Recent-activity sorting uses latest run `updatedAt`.
- Projects without runs use `project.updatedAt`.
- Composite status prioritizes `waiting_for_approval` and `failed` over `running`.
- Search matches project name, repository, and project type label.
- Collapsed selector replaces the always-expanded Projects list.
- Popover includes search, four filters, selected-project highlight, and empty state.
- Selecting a project selects its most recently updated run instead of the first matching run.

Standard verification for implementation:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
