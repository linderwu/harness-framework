# Technical Design

## Context
The local workflow architecture defines a default event-skill chain: requirement intake, plan interview, plan approval, OpenSpec design, design approval, implementation dispatch, verification generation, verification approval, and closeout. Each workflow run stores `selectedAgent` as the default executor and `skillAssignments` as the per-skill executor map. Approval gates are durable workflow records, not transient UI state.

## Data Model
The workflow run remains the aggregate boundary. Creation must persist:

- `projectName`, `repository`, `requirement`, source metadata, and current status.
- `selectedAgent` as the fallback executor.
- `skillAssignments: Record<string, AgentKind>` with one assignment per event skill.
- `approvalPolicies` for plan, design, and verification gates.
- `eventSkills`, `events`, `artifacts`, `approvalGates`, and `agentRuns`.

`AgentKind` is limited to `codex`, `openclaw`, and `manual` for MVP. `ApprovalActorType` is limited to `human`, `verification_subagent`, and `independent_agent`.

## Workflow Rules
Plan advancement creates a plan artifact and opens a pending PlanApproval gate. While a gate is pending, `advanceWorkflow` must return without starting the next stage. An approved PlanApproval resumes the run and allows OpenSpec design. A rejected PlanApproval fails the run. A changes-requested decision keeps the run in planning and does not create a design artifact.

Design advancement creates the OpenSpec change draft artifact and opens DesignApproval. Implementation dispatch is blocked until DesignApproval is approved. Verification advancement creates verification artifacts and opens VerificationApproval. Completion is blocked until VerificationApproval is approved.

Every generated event and agent run must resolve its executor from `skillAssignments[skill.id] ?? selectedAgent`. The fallback exists for legacy runs and incomplete state, not as the primary routing path.

## Approval Gate Records
Each gate must record:

- Stage and status.
- Requested-by source.
- Actor type and assigned agent when applicable.
- `requireIndependence`.
- Creation and decision timestamps.
- Decider identity.
- Decision note when supplied, with product decision pending on whether the note is mandatory.

For `independent_agent`, the gate should set `requireIndependence: true` and expose that requirement in the dashboard and agent prompt. Verification must assert the value is persisted and displayed.

## Dashboard Design
The dashboard should keep the workflow controls on the first screen:

- Create-run form with project, repository, requirement, default executor, per-skill executor assignment, design approval actor, and verification approval actor.
- Run summary with current stage and status.
- Event skill chain showing stage, skill name, assigned executor, constraints, gates, and verification rules.
- Approval gate panel with pending action buttons for approve, changes requested, and reject.
- Agent run panel showing stage, executor, status, and linked output artifact.
- Artifact panel showing requirement, plan, OpenSpec design, implementation, and verification outputs.

The UI must make the default executor/fallback relationship clear: the default executor initializes skill assignments, but each skill row owns the executor used at runtime.

## Adapter Boundary
Codex and OpenClaw should remain behind a shared agent invocation boundary. Codex may use the local bridge when configured. OpenClaw can use the same boundary with a separate URL/header configuration if a real runner is required; otherwise the MVP may continue to record simulated OpenClaw execution. The unresolved OpenClaw behavior is a blocking product decision for implementation scope, not for this design artifact.

## State and Concurrency
The current file-backed JSON state is acceptable for MVP but fragile under simultaneous dashboard/API writes. Implementation should keep writes centralized through workflow functions and avoid direct UI mutation of stored run records. If concurrent writes become in scope, add a version or updated-at guard before broadening behavior.

## Verification Strategy
Verification must map checks to acceptance criteria:

- Workflow logic tests for stage blocking, gate decisions, executor resolution, and legacy fallback behavior.
- API checks for create-run persistence, advance behavior while gates are pending, gate decision updates, and rejected/changes-requested transitions.
- Typecheck for model changes and dashboard props.
- UI/manual or browser check for visibility of executor assignment, approval policies, event chain, artifacts, agent runs, and pending gate controls.
