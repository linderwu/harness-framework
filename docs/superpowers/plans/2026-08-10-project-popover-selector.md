# Project Popover Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the always-expanded right-header Projects list with an informational project selector that opens a searchable, filterable recent-activity popover.

**Architecture:** Add a small selector view-model helper in `lib/project-selector.ts` so sorting, composite status, filtering, and time labels are testable outside React. Then replace the existing inline Projects list in `components/harness-dashboard.tsx` with a `ProjectSelector` component and add focused CSS for the collapsed panel and overlay popover.

**Tech Stack:** Next.js 16, React 18, TypeScript, lucide-react, CSS modules through `app/globals.css`, Node test runner compiled by the existing `npm test` script.

---

## File Structure

- Create: `lib/project-selector.ts`
  - Selector-specific view models and pure helpers.
  - No React imports.
  - Depends on `Project`, `WorkflowRun`, and `ProjectType` labels.
- Create: `tests/project-selector.test.ts`
  - Unit tests for sorting, latest run selection, composite status, filters, search, and date fallback.
- Modify: `package.json`
  - Add `tests/project-selector.test.ts` and `lib/project-selector.ts` to the explicit `npm test` compile list.
- Modify: `components/harness-dashboard.tsx`
  - Import helper functions and types.
  - Add local `ProjectSelector` and `ProjectOption` components.
  - Replace the current expanded `projects.map(...)` panel with `ProjectSelector`.
  - Change project switching to use the selected item's latest updated run.
- Modify: `app/globals.css`
  - Add collapsed selector, popover, project option, status dot, filter, and empty-state styles.
  - Preserve current `workspace` row height and `runsPanel` visual direction.
- Modify: `tests/harness-dashboard-structure.test.ts`
  - Assert the dashboard uses `ProjectSelector`, no longer renders the always-expanded project list inline, and selects projects through latest-run metadata.
- Modify: `tests/layout-css.test.ts`
  - Assert selector/popover rules preserve stable dimensions and overlay behavior.

---

### Task 1: Add Selector Helper Tests

**Files:**
- Create: `tests/project-selector.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the failing helper test file**

Create `tests/project-selector.test.ts` with:

```ts
import { test } from "node:test"
import { strict as assert } from "node:assert"
import type { Project, WorkflowRun } from "../lib/types"
import {
  buildProjectSelectorItems,
  filterProjectSelectorItems,
  formatAbsoluteActivityTime,
  formatRelativeActivityTime,
  getProjectCompositeStatus
} from "../lib/project-selector"

function project(
  id: string,
  overrides: Partial<Project> = {}
): Project {
  return {
    id,
    name: `${id} project`,
    type: "development",
    goal: "Ship useful work",
    status: "active",
    currentPhase: "Plan",
    nextAction: "Continue",
    repository: `${id}/repo`,
    source: "dashboard",
    contextFiles: [],
    artifactIds: [],
    workflowRunIds: [],
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    ...overrides
  }
}

function run(
  id: string,
  projectId: string,
  overrides: Partial<WorkflowRun> = {}
): WorkflowRun {
  return {
    schemaVersion: 3,
    version: 1,
    id,
    projectId,
    projectName: `${projectId} project`,
    repository: `${projectId}/repo`,
    requirement: "Run the workflow",
    contextFiles: [],
    source: "dashboard",
    currentStage: "plan",
    status: "running",
    selectedAgent: "codex",
    stageModes: {
      intake: "agent",
      plan: "agent",
      design: "agent",
      implementation: "agent",
      verification: "agent",
      completed: "manual"
    },
    skillAssignments: {},
    approvalPolicies: [],
    eventSkills: [],
    events: [],
    artifacts: [],
    approvalGates: [],
    agentRuns: [],
    revisions: [],
    eventLogStatus: "consistent",
    createdAt: "2026-08-10T08:30:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    ...overrides
  }
}

test("selector items sort by latest run activity first", () => {
  const items = buildProjectSelectorItems(
    [
      project("alpha", { updatedAt: "2026-08-10T12:00:00.000Z" }),
      project("bravo", { updatedAt: "2026-08-10T09:00:00.000Z" })
    ],
    [
      run("old-alpha-run", "alpha", {
        updatedAt: "2026-08-10T12:30:00.000Z"
      }),
      run("fresh-bravo-run", "bravo", {
        updatedAt: "2026-08-10T13:00:00.000Z"
      })
    ]
  )

  assert.deepEqual(
    items.map((item) => item.project.id),
    ["bravo", "alpha"]
  )
  assert.equal(items[0].latestRun?.id, "fresh-bravo-run")
})

test("projects without runs use project updatedAt for activity", () => {
  const [item] = buildProjectSelectorItems(
    [project("solo", { updatedAt: "2026-08-10T14:00:00.000Z" })],
    []
  )

  assert.equal(item.latestRun, undefined)
  assert.equal(item.activityAt, "2026-08-10T14:00:00.000Z")
  assert.equal(item.latestRunSummary, "No runs yet")
})

test("invalid activity timestamps sort last and show unknown activity", () => {
  const items = buildProjectSelectorItems(
    [
      project("broken", { updatedAt: "not-a-date" }),
      project("healthy", { updatedAt: "2026-08-10T15:00:00.000Z" })
    ],
    []
  )

  assert.deepEqual(
    items.map((item) => item.project.id),
    ["healthy", "broken"]
  )
  assert.equal(items[1].relativeActivityLabel, "Unknown activity")
})

test("composite status prioritizes needs attention over running", () => {
  const status = getProjectCompositeStatus(
    project("status"),
    [
      run("running", "status", { status: "running" }),
      run("failed", "status", { status: "failed" })
    ]
  )

  assert.equal(status.group, "needs_attention")
  assert.equal(status.label, "failed")
})

test("filters use coarse selector status groups", () => {
  const items = buildProjectSelectorItems(
    [
      project("active"),
      project("attention"),
      project("done", { status: "completed" })
    ],
    [run("attention-run", "attention", { status: "waiting_for_approval" })]
  )

  assert.deepEqual(
    filterProjectSelectorItems(items, "", "needs_attention").map(
      (item) => item.project.id
    ),
    ["attention"]
  )
  assert.deepEqual(
    filterProjectSelectorItems(items, "", "completed").map(
      (item) => item.project.id
    ),
    ["done"]
  )
})

test("search matches project name, repository, and type label", () => {
  const items = buildProjectSelectorItems(
    [
      project("docs", {
        name: "Reference Library",
        repository: "linder/reference",
        type: "documentation"
      }),
      project("qa", {
        name: "Regression Matrix",
        repository: "linder/quality",
        type: "testing"
      })
    ],
    []
  )

  assert.deepEqual(
    filterProjectSelectorItems(items, "reference", "all").map(
      (item) => item.project.id
    ),
    ["docs"]
  )
  assert.deepEqual(
    filterProjectSelectorItems(items, "quality", "all").map(
      (item) => item.project.id
    ),
    ["qa"]
  )
  assert.deepEqual(
    filterProjectSelectorItems(items, "Documentation", "all").map(
      (item) => item.project.id
    ),
    ["docs"]
  )
})

test("time formatting provides relative and absolute labels", () => {
  assert.equal(
    formatRelativeActivityTime(
      "2026-08-10T11:57:00.000Z",
      new Date("2026-08-10T12:00:00.000Z")
    ),
    "3 minutes ago"
  )
  assert.equal(
    formatAbsoluteActivityTime("2026-08-10T11:57:00.000Z"),
    "2026-08-10 11:57"
  )
})
```

- [ ] **Step 2: Add the new test file to the explicit npm test compile list**

Modify the `test` script in `package.json` so the compile command includes:

```json
"tests/project-selector.test.ts"
```

and the library list includes:

```json
"lib/project-selector.ts"
```

Keep the existing script shape. The resulting `test` script should still end with:

```json
"&& node --test .tmp-tests/tests/*.test.js"
```

- [ ] **Step 3: Run the new tests and verify they fail for the missing helper**

Run:

```bash
npm test
```

Expected: TypeScript fails because `../lib/project-selector` does not exist yet.

- [ ] **Step 4: Commit the red helper tests**

```bash
git add package.json tests/project-selector.test.ts
git commit -m "Specify project selector view model behavior" -m "The selector needs deterministic recent-activity sorting, composite status, filtering, and time labels before the React UI is changed." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: npm test fails because lib/project-selector is not implemented yet" -m "Not-tested: Runtime selector UI"
```

---

### Task 2: Implement Project Selector Helpers

**Files:**
- Create: `lib/project-selector.ts`
- Test: `tests/project-selector.test.ts`

- [ ] **Step 1: Create `lib/project-selector.ts`**

Add:

```ts
import { getProjectTemplate } from "@/lib/project-templates"
import type { Project, WorkflowRun, WorkflowStatus } from "@/lib/types"

export type ProjectSelectorFilter =
  | "all"
  | "active"
  | "needs_attention"
  | "completed"

export type ProjectSelectorStatusGroup =
  | "needs_attention"
  | "running"
  | "active"
  | "done"

export interface ProjectSelectorStatus {
  group: ProjectSelectorStatusGroup
  label: string
  dotVariant: ProjectSelectorStatusGroup
}

export interface ProjectSelectorItem {
  project: Project
  projectTypeLabel: string
  projectRuns: WorkflowRun[]
  latestRun?: WorkflowRun
  latestRunSummary: string
  activityAt?: string
  activityTime: number
  relativeActivityLabel: string
  absoluteActivityLabel: string
  status: ProjectSelectorStatus
}

export function buildProjectSelectorItems(
  projects: Project[],
  runs: WorkflowRun[],
  now = new Date()
) {
  return projects
    .map((project) => {
      const projectRuns = runs
        .filter((run) => run.projectId === project.id)
        .sort((a, b) => compareActivityDescending(a.updatedAt, b.updatedAt))
      const latestRun = projectRuns[0]
      const activityAt = latestRun?.updatedAt ?? project.updatedAt
      const activityTime = parseActivityTime(activityAt)
      const projectTypeLabel = getProjectTemplate(project.type).label

      return {
        project,
        projectRuns,
        latestRun,
        projectTypeLabel,
        activityAt,
        activityTime,
        relativeActivityLabel: formatRelativeActivityTime(activityAt, now),
        absoluteActivityLabel: formatAbsoluteActivityTime(activityAt),
        latestRunSummary: latestRun
          ? `Latest run: ${latestRun.status} - ${stageDisplay(latestRun.currentStage)}`
          : "No runs yet",
        status: getProjectCompositeStatus(project, projectRuns)
      } satisfies ProjectSelectorItem
    })
    .sort((a, b) => b.activityTime - a.activityTime)
}

export function filterProjectSelectorItems(
  items: ProjectSelectorItem[],
  query: string,
  filter: ProjectSelectorFilter
) {
  const normalizedQuery = query.trim().toLowerCase()

  return items.filter((item) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "needs_attention" &&
        item.status.group === "needs_attention") ||
      (filter === "active" &&
        (item.status.group === "running" || item.status.group === "active")) ||
      (filter === "completed" && item.status.group === "done")

    if (!matchesFilter) {
      return false
    }

    if (normalizedQuery.length === 0) {
      return true
    }

    return [
      item.project.name,
      item.project.repository,
      item.projectTypeLabel
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  })
}

export function getProjectCompositeStatus(
  project: Project,
  projectRuns: WorkflowRun[]
): ProjectSelectorStatus {
  const runStatuses = projectRuns.map((run) => run.status)

  if (runStatuses.includes("failed")) {
    return status("needs_attention", "failed")
  }

  if (runStatuses.includes("waiting_for_approval")) {
    return status("needs_attention", "waiting_for_approval")
  }

  if (runStatuses.includes("running")) {
    return status("running", "running")
  }

  if (
    runStatuses.some(isActiveRunStatus) ||
    project.status === "active" ||
    project.status === "waiting_for_approval" ||
    project.status === "stopped" ||
    project.status === "failed"
  ) {
    return status(project.status === "failed" ? "needs_attention" : "active", project.status)
  }

  return status("done", project.status)
}

export function formatRelativeActivityTime(
  value: string | undefined,
  now = new Date()
) {
  const activityTime = parseActivityTime(value)

  if (activityTime === 0) {
    return "Unknown activity"
  }

  const diffMs = Math.max(0, now.getTime() - activityTime)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (diffMs < minute) {
    return "just now"
  }

  if (diffMs < hour) {
    const minutes = Math.floor(diffMs / minute)
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`
  }

  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour)
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`
  }

  if (diffMs < 2 * day) {
    return "yesterday"
  }

  const days = Math.floor(diffMs / day)
  return `${days} days ago`
}

export function formatAbsoluteActivityTime(value: string | undefined) {
  const activityTime = parseActivityTime(value)

  if (activityTime === 0) {
    return "Unknown activity"
  }

  const date = new Date(activityTime)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  const hours = String(date.getUTCHours()).padStart(2, "0")
  const minutes = String(date.getUTCMinutes()).padStart(2, "0")

  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function compareActivityDescending(a: string | undefined, b: string | undefined) {
  return parseActivityTime(b) - parseActivityTime(a)
}

function parseActivityTime(value: string | undefined) {
  if (!value) {
    return 0
  }

  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

function status(
  group: ProjectSelectorStatusGroup,
  label: string
): ProjectSelectorStatus {
  return {
    group,
    label,
    dotVariant: group
  }
}

function isActiveRunStatus(status: WorkflowStatus) {
  return status === "pending" || status === "stopped"
}

function stageDisplay(stage: string) {
  return stage.charAt(0).toUpperCase() + stage.slice(1).replace(/_/g, " ")
}
```

- [ ] **Step 2: Run helper tests**

Run:

```bash
npm test
```

Expected: all tests pass, including `tests/project-selector.test.ts`.

- [ ] **Step 3: Commit helper implementation**

```bash
git add lib/project-selector.ts tests/project-selector.test.ts package.json
git commit -m "Derive project selector state from recent activity" -m "The UI can stay small if project/run aggregation is handled by pure helpers with deterministic sorting and status rules." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: npm test" -m "Not-tested: Browser rendering of selector popover"
```

---

### Task 3: Replace Inline Projects List With ProjectSelector

**Files:**
- Modify: `components/harness-dashboard.tsx`

- [ ] **Step 1: Update imports**

Add `useEffect` to the React import list and import selector helpers:

```ts
import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"
```

```ts
import {
  buildProjectSelectorItems,
  filterProjectSelectorItems,
  type ProjectSelectorFilter,
  type ProjectSelectorItem
} from "@/lib/project-selector"
```

- [ ] **Step 2: Add selector item memoization near existing selected project memos**

Replace the current raw selected-project fallback with selector items:

```ts
const projectSelectorItems = useMemo(
  () => buildProjectSelectorItems(projects, runs),
  [projects, runs]
)
const selectedProject = useMemo(
  () =>
    projectSelectorItems.find((item) => item.project.id === selectedProjectId)
      ?.project ?? projectSelectorItems[0]?.project,
  [projectSelectorItems, selectedProjectId]
)
```

Keep `selectedProjectRuns`, `selectedRun`, and `selectedOverview` below it.

- [ ] **Step 3: Keep selection valid after refreshes**

Add this effect after `selectedOverview`:

```ts
useEffect(() => {
  if (projectSelectorItems.length === 0) {
    setSelectedProjectId(undefined)
    setSelectedRunId(undefined)
    return
  }

  const selectedItem = projectSelectorItems.find(
    (item) => item.project.id === selectedProjectId
  )

  if (!selectedItem) {
    const fallbackItem = projectSelectorItems[0]
    setSelectedProjectId(fallbackItem.project.id)
    setSelectedRunId(fallbackItem.latestRun?.id)
  }
}, [projectSelectorItems, selectedProjectId])
```

- [ ] **Step 4: Update `refreshWorkspace` selected run fallback**

Inside `refreshWorkspace`, replace the current `setSelectedRunId` callback with:

```ts
setSelectedRunId((current) => {
  if (nextRuns.some((run) => run.id === current)) {
    return current
  }

  const activeProjectId =
    nextProjects.some((project) => project.id === selectedProjectId)
      ? selectedProjectId
      : nextProjects[0]?.id
  const latestRun = nextRuns
    .filter((run) => run.projectId === activeProjectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]

  return latestRun?.id
})
```

- [ ] **Step 5: Replace the current expanded Projects panel JSX**

Replace the `<div className="panel runsPanel">...</div>` inside `<section className="workspace">` with:

```tsx
<ProjectSelector
  isLoading={isLoading}
  items={projectSelectorItems}
  selectedProjectId={selectedProject?.id}
  onSelectProject={(item) => {
    setSelectedProjectId(item.project.id)
    setSelectedRunId(item.latestRun?.id)
  }}
/>
```

- [ ] **Step 6: Add `ProjectSelector` and `ProjectOption` before `buildProjectOverview`**

Add:

```tsx
function ProjectSelector({
  isLoading,
  items,
  selectedProjectId,
  onSelectProject
}: {
  isLoading: boolean
  items: ProjectSelectorItem[]
  selectedProjectId?: string
  onSelectProject: (item: ProjectSelectorItem) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<ProjectSelectorFilter>("all")
  const selectedItem =
    items.find((item) => item.project.id === selectedProjectId) ?? items[0]
  const visibleItems = filterProjectSelectorItems(items, query, filter)

  function clearFilters() {
    setQuery("")
    setFilter("all")
  }

  return (
    <div className="panel runsPanel projectSelector">
      <button
        aria-expanded={isOpen}
        className="projectSelectorSummary"
        onClick={() => items.length > 0 && setIsOpen((current) => !current)}
        type="button"
      >
        <span className="projectSelectorHeader">
          <span>
            <GitBranch size={18} />
            <strong>Projects</strong>
          </span>
          <ChevronDown size={18} />
        </span>

        {isLoading ? (
          <span className="muted">Loading</span>
        ) : selectedItem ? (
          <span className="projectSelectorCurrent">
            <span
              className={`projectStatusDot ${selectedItem.status.dotVariant}`}
              aria-hidden="true"
            />
            <span>
              <strong title={selectedItem.project.name}>
                {selectedItem.project.name}
              </strong>
              <small title={selectedItem.absoluteActivityLabel}>
                {selectedItem.projectTypeLabel} - {selectedItem.status.label} -{" "}
                {selectedItem.relativeActivityLabel}
              </small>
            </span>
          </span>
        ) : (
          <span className="muted">No projects yet</span>
        )}
      </button>

      {isOpen ? (
        <div className="projectSelectorPopover">
          <div className="projectSelectorControls">
            <label className="projectSearch">
              <Search size={16} />
              <input
                aria-label="Search projects"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects..."
                value={query}
              />
            </label>
            <div className="segmented projectFilter">
              {[
                ["all", "All"],
                ["active", "Active"],
                ["needs_attention", "Needs attention"],
                ["completed", "Completed"]
              ].map(([value, label]) => (
                <button
                  className={filter === value ? "selected" : ""}
                  key={value}
                  onClick={() => setFilter(value as ProjectSelectorFilter)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {visibleItems.length === 0 ? (
            <div className="projectSelectorEmpty">
              <p className="muted">No projects found</p>
              <button
                className="iconTextButton"
                onClick={clearFilters}
                type="button"
              >
                <RotateCcw size={15} />
                Clear filters
              </button>
            </div>
          ) : (
            <div className="projectSelectorList">
              {visibleItems.map((item) => (
                <ProjectOption
                  item={item}
                  isSelected={item.project.id === selectedProjectId}
                  key={item.project.id}
                  onSelect={() => {
                    onSelectProject(item)
                    setIsOpen(false)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function ProjectOption({
  item,
  isSelected,
  onSelect
}: {
  item: ProjectSelectorItem
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      className={isSelected ? "projectOption selected" : "projectOption"}
      onClick={onSelect}
      type="button"
    >
      <span
        className={`projectStatusDot ${item.status.dotVariant}`}
        aria-hidden="true"
      />
      <span>
        <strong title={item.project.name}>{item.project.name}</strong>
        <small title={item.absoluteActivityLabel}>
          {item.projectTypeLabel} - {item.status.label} -{" "}
          {item.relativeActivityLabel}
        </small>
        <small>{item.latestRunSummary}</small>
      </span>
    </button>
  )
}
```

- [ ] **Step 7: Run typecheck and fix import or type drift**

Run:

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 8: Commit React wiring**

```bash
git add components/harness-dashboard.tsx
git commit -m "Replace project list with a popover selector" -m "The workspace header now presents the selected project as a summary and opens a searchable popover for switching projects by recent activity." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: npm run typecheck" -m "Not-tested: Browser visual inspection and full build"
```

---

### Task 4: Style the Selector and Popover

**Files:**
- Modify: `app/globals.css`
- Test: `tests/layout-css.test.ts`

- [ ] **Step 1: Add failing CSS structure assertions**

Append to `tests/layout-css.test.ts`:

```ts
test("project selector keeps the workspace header stable and overlays its popover", () => {
  const selectorRule = ruleBody(/\.projectSelector/, ".projectSelector")
  const summaryRule = ruleBody(/\.projectSelectorSummary/, ".projectSelectorSummary")
  const popoverRule = ruleBody(/\.projectSelectorPopover/, ".projectSelectorPopover")

  assert.match(selectorRule, /position:\s*relative;/)
  assert.match(summaryRule, /min-height:\s*100%;/)
  assert.match(popoverRule, /position:\s*absolute;/)
  assert.match(popoverRule, /z-index:\s*10;/)
})
```

- [ ] **Step 2: Run the CSS test and verify it fails**

Run:

```bash
npm test
```

Expected: fails because `.projectSelector`, `.projectSelectorSummary`, and `.projectSelectorPopover` do not exist in CSS.

- [ ] **Step 3: Add selector CSS**

Add after the existing `.runsPanel` rule:

```css
.projectSelector {
  overflow: visible;
  padding: 0;
  position: relative;
}

.projectSelectorSummary {
  background: transparent;
  border: 0;
  color: var(--text);
  display: grid;
  gap: 10px;
  min-height: 100%;
  padding: 16px;
  text-align: left;
  width: 100%;
}

.projectSelectorHeader,
.projectSelectorHeader span,
.projectSelectorCurrent,
.projectOption {
  align-items: center;
  display: flex;
}

.projectSelectorHeader {
  justify-content: space-between;
}

.projectSelectorHeader span {
  gap: 9px;
}

.projectSelectorCurrent {
  gap: 10px;
  min-width: 0;
}

.projectSelectorCurrent > span:last-child,
.projectOption > span:last-child {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.projectSelectorCurrent strong,
.projectSelectorCurrent small,
.projectOption strong,
.projectOption small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.projectStatusDot {
  border-radius: 999px;
  box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.18);
  flex: 0 0 auto;
  height: 10px;
  width: 10px;
}

.projectStatusDot.needs_attention {
  background: #dc2626;
}

.projectStatusDot.running {
  background: #16a34a;
}

.projectStatusDot.active {
  background: #2563eb;
}

.projectStatusDot.done {
  background: #64748b;
}

.projectSelectorPopover {
  background: rgba(251, 253, 255, 0.98);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.18);
  display: grid;
  gap: 12px;
  left: 0;
  max-height: min(520px, calc(100vh - 190px));
  overflow: hidden;
  padding: 12px;
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 10;
}

.projectSelectorControls {
  display: grid;
  gap: 10px;
}

.projectSearch {
  align-items: center;
  background: #ffffff;
  border: 1px solid var(--panel-border);
  border-radius: 7px;
  display: flex;
  gap: 8px;
  padding: 0 10px;
}

.projectSearch input {
  border: 0;
  min-height: 38px;
  outline: 0;
  width: 100%;
}

.projectFilter {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.projectSelectorList {
  display: grid;
  gap: 8px;
  min-height: 0;
  overflow: auto;
  padding-right: 2px;
}

.projectOption {
  background: #ffffff;
  border: 1px solid var(--panel-border);
  border-radius: 7px;
  color: var(--text);
  gap: 10px;
  padding: 11px;
  text-align: left;
}

.projectOption.selected {
  background:
    linear-gradient(90deg, rgba(37, 99, 235, 0.16), rgba(8, 145, 178, 0.1)),
    #dbeafe;
  border-color: #93b4f5;
}

.projectSelectorEmpty {
  align-items: center;
  display: flex;
  justify-content: space-between;
  min-height: 64px;
}
```

- [ ] **Step 4: Run CSS and full test suite**

Run:

```bash
npm test
```

Expected: pass.

- [ ] **Step 5: Commit CSS**

```bash
git add app/globals.css tests/layout-css.test.ts
git commit -m "Style the project selector popover" -m "The selector keeps the right workspace header stable while the project list opens as an overlay with search, filters, and compact project options." -m "Confidence: medium" -m "Scope-risk: narrow" -m "Tested: npm test" -m "Not-tested: Browser screenshot review"
```

---

### Task 5: Add Dashboard Structure Regression Tests

**Files:**
- Modify: `tests/harness-dashboard-structure.test.ts`

- [ ] **Step 1: Add structure tests**

Append:

```ts
test("dashboard uses project selector instead of an always-expanded project list", () => {
  assert.match(dashboard, /<ProjectSelector/)
  assert.match(dashboard, /function ProjectSelector\(/)
  assert.doesNotMatch(dashboard, /projects\.map\(\(project\) =>\s*\(\s*<button[\s\S]*className=\{[\s\S]*runRow active/)
})

test("project selector selection uses the latest run from the selector item", () => {
  const dashboardShell = dashboard.slice(
    dashboard.indexOf("<ProjectSelector"),
    dashboard.indexOf("</section>", dashboard.indexOf("<ProjectSelector"))
  )

  assert.match(dashboardShell, /setSelectedProjectId\(item\.project\.id\)/)
  assert.match(dashboardShell, /setSelectedRunId\(item\.latestRun\?\.id\)/)
})
```

- [ ] **Step 2: Run structure tests**

Run:

```bash
npm test
```

Expected: pass.

- [ ] **Step 3: Commit structure coverage**

```bash
git add tests/harness-dashboard-structure.test.ts
git commit -m "Guard the project selector dashboard shape" -m "The dashboard should not regress back to the always-expanded Projects list or first-run project switching behavior." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: npm test" -m "Not-tested: Browser interaction"
```

---

### Task 6: Final Verification and Browser Smoke Test

**Files:**
- No planned source edits unless verification exposes issues.

- [ ] **Step 1: Run static verification**

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all commands pass.

- [ ] **Step 2: Start the dev server**

Run:

```bash
npm run dev
```

Expected: Next.js starts and prints a local URL, usually `http://localhost:3000`.

- [ ] **Step 3: Manually smoke test the selector in browser**

Verify:

- The right workspace header shows the collapsed `Projects` selector.
- Clicking the selector opens an overlay popover.
- Search filters by project name, repository, and type label.
- `All`, `Active`, `Needs attention`, and `Completed` filters update the visible options.
- No-result state shows `No projects found` and `Clear filters`.
- Selecting a project closes the popover and updates the detail panel.
- The selected run is the latest updated run for that project.
- Long project names truncate instead of growing the header.

- [ ] **Step 4: Fix any verification failures**

If a command fails, make the smallest targeted fix, rerun the failing command, then rerun the full static verification from Step 1.

- [ ] **Step 5: Final commit only if fixes were needed**

If Step 4 changed files:

```bash
git add components/harness-dashboard.tsx app/globals.css lib/project-selector.ts tests/project-selector.test.ts tests/harness-dashboard-structure.test.ts tests/layout-css.test.ts package.json
git commit -m "Stabilize project selector verification" -m "Verification found issues after the selector implementation, so this commit captures the targeted fixes and final passing evidence." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: npm run typecheck; npm run lint; npm test; npm run build; browser smoke test" -m "Not-tested: Multi-user concurrent browser sessions"
```

---

## Self-Review

Spec coverage:

- Collapsed informational selector: Task 3 and Task 4.
- Overlay popover without layout push: Task 4 and Task 6.
- Search and segmented filters: Task 2, Task 3, Task 5.
- Recent-activity sorting: Task 1 and Task 2.
- Latest updated run selected on project switch: Task 2, Task 3, Task 5.
- Composite status dot and coarse filter groups: Task 1, Task 2, Task 4.
- Empty states and clear filters: Task 3, Task 4, Task 6.
- Invalid dates: Task 1 and Task 2.
- No project creation action inside popover: Task 3 and Task 6.

Red-flag scan:

- No unresolved marker text or open-ended implementation steps remain.
- Every code-editing step includes concrete code or exact replacement guidance.

Type consistency:

- `ProjectSelectorFilter`, `ProjectSelectorItem`, `buildProjectSelectorItems`, `filterProjectSelectorItems`, and `getProjectCompositeStatus` are defined in Task 2 before React usage in Task 3.
- Status group values match CSS class suffixes: `needs_attention`, `running`, `active`, `done`.
