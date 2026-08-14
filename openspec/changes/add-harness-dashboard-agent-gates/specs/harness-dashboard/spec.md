# Harness Dashboard Specification Delta

## ADDED Requirements

### Requirement: Workflow Run Configuration Persistence
The system SHALL persist a workflow run's project, repository, requirement, default executor, per-skill executor assignments, and plan/design/verification approval policies when the run is created.

#### Scenario: Create a configured workflow run
- GIVEN a dashboard create-run request with project, repository, requirement, default executor, skill assignments, and approval policies
- WHEN the workflow run is created
- THEN the stored run includes all submitted configuration fields
- AND every default event skill has an executor assignment
- AND approval policies exist for PlanApproval, DesignApproval, and VerificationApproval

### Requirement: Plan Approval Blocks Design
The system SHALL block OpenSpec design until PlanApproval is approved.

#### Scenario: Plan approval is pending
- GIVEN intake has advanced and a plan artifact exists
- AND PlanApproval is pending
- WHEN the workflow is advanced
- THEN no design artifact is created
- AND the run remains waiting for approval

#### Scenario: Plan approval is approved
- GIVEN PlanApproval is pending
- WHEN the gate is approved
- THEN the run can advance into design

#### Scenario: Plan approval is rejected
- GIVEN PlanApproval is pending
- WHEN the gate is rejected
- THEN the run is marked failed
- AND design does not start

#### Scenario: Plan changes are requested
- GIVEN PlanApproval is pending
- WHEN changes are requested
- THEN the run remains in planning
- AND design does not start

### Requirement: Design And Verification Approval Gates
The system SHALL require DesignApproval before implementation and VerificationApproval before completion.

#### Scenario: Design approval blocks implementation
- GIVEN an OpenSpec design artifact exists
- AND DesignApproval is pending
- WHEN the workflow is advanced
- THEN implementation does not start

#### Scenario: Verification approval blocks completion
- GIVEN verification artifacts exist
- AND VerificationApproval is pending
- WHEN the workflow is advanced
- THEN the run is not completed

#### Scenario: Gate decision metadata is persisted
- GIVEN an approval gate is pending
- WHEN a decision is recorded
- THEN the gate records status, actor type, assigned agent when applicable, independence requirement, decider, decision timestamp, and decision note when supplied

### Requirement: Per-Skill Executor Resolution
The system SHALL execute each workflow event with its per-skill assigned executor, falling back to the workflow default only when no assignment exists.

#### Scenario: Skill assignment overrides default executor
- GIVEN the workflow default executor is `codex`
- AND `design.openspec` is assigned to `openclaw`
- WHEN design runs
- THEN the design agent run records `openclaw`

#### Scenario: Missing assignment falls back to default executor
- GIVEN a legacy workflow run has no assignment for a skill
- WHEN that skill runs
- THEN the agent run records the workflow default executor

### Requirement: Dashboard Workflow Visibility
The dashboard SHALL display the current stage, event skill chain, assigned executor, artifacts, agent runs, approval policies, and pending gate actions for the active workflow run.

#### Scenario: Pending gate is actionable
- GIVEN a workflow run has a pending approval gate
- WHEN the dashboard renders the run
- THEN the pending gate is visible
- AND approve, changes-requested, and reject actions are available

#### Scenario: Skill chain shows executor assignments
- GIVEN a workflow run has per-skill executor assignments
- WHEN the dashboard renders the event skill chain
- THEN each skill row shows the resolved executor for that skill
