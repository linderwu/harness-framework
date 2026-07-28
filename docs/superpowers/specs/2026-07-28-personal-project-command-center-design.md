# Personal Project Command Center Design

## Purpose

Generalize Jormungandr from an agent workflow harness into a personal project command center.

The product should help one person command knowledge-work projects across six core project types:

- Research
- Development
- Testing
- Documentation
- Diagnosis
- Decision

The application should feel like a workspace for active projects, not a single-run workflow simulator. Existing workflow concepts remain useful, but they become execution records inside a broader workspace model.

## Approved Direction

Use a full workspace model:

- `Workspace` is the top-level personal work surface.
- `Project` is the central domain entity.
- `WorkflowRun` becomes one execution record under a project.
- `Artifact`, `ApprovalGate`, `AgentRun`, `ContextFile`, and `WorkflowEvent` remain part of execution history, but the UI presents them through the project command surface.

This direction is larger than a template-only rename, but it creates cleaner long-term boundaries for personal project management.

## First-Version Scope

The first version should implement the full model architecture but land a focused vertical slice:

- Project list and active project view
- Project creation with one of the six project types
- Project overview: name, type, goal, status, current phase, next action
- Project timeline using project phases plus workflow run events
- Project artifacts, approval gates, agent runs, and context files
- Run controls scoped to a selected project

The first version should not implement a full personal operating system. Global inbox, notes, calendar, people, source connections, and cross-project analytics can be reserved for later.

## Domain Model

### Workspace

Represents the user's personal command environment.

Initial fields:

- `schemaVersion`
- `projects`
- `workflowRuns`

Future-ready fields are limited to optional workspace settings, global inbox items, and source connections. They are not required for the first version.

### Project

Represents a durable unit of work.

Required first-version fields:

- `id`
- `name`
- `type`
- `goal`
- `status`
- `currentPhase`
- `nextAction`
- `repository`
- `source`
- `sourceRef`
- `contextFiles`
- `artifactIds`
- `workflowRunIds`
- `createdAt`
- `updatedAt`

`Project.type` values:

- `research`
- `development`
- `testing`
- `documentation`
- `diagnosis`
- `decision`

### Project Template

Each project type owns phase labels, default artifacts, and creation prompts.

Research phases:

- Brief
- Research Plan
- Evidence
- Synthesis
- Review
- Completed

Development phases:

- Intake
- Plan
- Design
- Build
- Verify
- Completed

Testing phases:

- Goal
- Test Plan
- Cases
- Execute
- Report
- Completed

Documentation phases:

- Brief
- Outline
- Draft
- Review
- Publish
- Completed

Diagnosis phases:

- Report
- Reproduce
- Diagnose
- Fix Plan
- Verify
- Completed

Decision phases:

- Question
- Options
- Evidence
- Tradeoff
- Record
- Completed

### WorkflowRun

Represents one execution attempt, automation pass, or agent-assisted workflow for a project.

Existing fields can be reused, but each run must gain a `projectId`. Existing harness data without a `projectId` is normalized into legacy projects during migration.

### Artifact

Represents durable output: research notes, plans, designs, patches, reports, findings, decision records, screenshots, and logs.

Artifacts are visible from the project first and from individual runs second.

### ApprovalGate

Represents a human or agent review point.

Gates remain tied to execution details but are surfaced in the project command queue so the user can see what needs action.

## UI Design

### Shell

The first screen is the working product, not a landing page.

Recommended layout:

- Left navigation: Workspace, Projects, Artifacts, Decisions, Agents, and project type filters
- Main pane: selected project overview, phase timeline, artifacts, and execution history
- Right command pane: next actions, run controls, pending gates, and context

### Project Creation

Replace "New Workflow Run" with "New Project".

Creation fields:

- Project type
- Project name
- Goal
- Repository or source reference
- Context files
- Default executor / agent policy

After creating a project, the user can start a run from that project.

### Project Detail

The selected project view should answer:

- What is this project trying to accomplish?
- What type of work is it?
- What phase is it in?
- What needs my attention next?
- What has already been produced?
- Which agents or manual runs contributed?
- Which gates are pending or decided?

### Execution Controls

Existing run actions remain but are scoped to the active project:

- Start run
- Advance
- Stop stage
- Cancel run
- Approve
- Request changes
- Reject

## Data Flow

1. User creates a project from a project type template.
2. The project initializes its phase list, next action, context files, and default execution settings.
3. User starts a workflow run from the project.
4. Run events produce artifacts, gates, agent runs, and status changes.
5. The project aggregates run state into project overview, timeline, command queue, and artifact list.
6. Approval decisions update both the run and the project command surface.

## Migration

Existing `workflowRuns` remain readable.

Migration strategy:

- Add `projects` to the persisted state.
- For each existing run without a project, create a project using the run's `projectName`, `repository`, `requirement`, `contextFiles`, `source`, and `sourceRef`.
- Set project type to `development` for existing runs, because the current app's stage model is closest to development.
- Add `projectId` to the run.
- Keep old fields available during normalization so previous state files do not break.

## Error Handling

- Missing project for a run: normalize into a legacy development project.
- Unknown project type: normalize to `development` and surface a warning.
- Missing template phase: fall back to the development template.
- Stale mutation version: preserve the existing conflict behavior and return the latest project/run state.
- Missing artifact references: keep current drift detection and extend it to project artifact references.

## Testing

Add focused tests around the model conversion and project aggregation:

- Existing state without projects normalizes into development projects.
- New project creation applies the correct template phases.
- Starting a run links the run to the selected project.
- Project overview aggregates pending gates, artifacts, and run status.
- Existing approval and run mutation flows still work after introducing `projectId`.

Run standard verification:

- `npm run typecheck`
- `npm run lint`
- `npm run build`

## Open Decisions

No blocking open decisions remain for the design stage.

The first implementation plan must decide exact component boundaries after reading the current dashboard component in detail. The design intent is fixed: full workspace model, six project types, project-first UI, and workflow runs as execution records.
