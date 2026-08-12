---
title: workflow-spec
type: spec
module: workflow
visibility: internal
created: 2026-08-11
updated: 2026-08-11
---

# Workflow Engine

## Summary

The workflow engine builds and advances workflow runs through intake, plan, design, implementation, verification, and completion states.

## Source of Truth

- Primary path: `repos/jormungand/lib/workflow.ts`
- Shared types: `repos/jormungand/lib/types.ts`
- Entity: [[wiki/entities/workflow-engine]]

## Construction Blueprint

### Core Features

- Create workflow runs from project requirements.
- Advance current stage based on artifacts, approvals, and executor results.
- Open approval gates for human or independent-agent review.
- Record workflow events, artifacts, revisions, and agent runs.
- Support cancellation and stage stopping.

### Inputs

- `WorkflowRun`
- selected `WorkflowEventSkill`
- executor callbacks such as `invokeConfiguredAgent`
- runtime skill resolution callback

### Outputs

- Updated `WorkflowRun`
- `Artifact` entries
- `ApprovalGate` entries
- `WorkflowEvent` entries
- `AgentRun` entries

### Side Effects

The workflow engine returns mutated workflow state. Route/store layers persist that state.

## Interface

```ts
createWorkflowRun(input): WorkflowRun
advanceWorkflow(run, options): Promise<WorkflowRun>
cancelWorkflowRun(run): WorkflowRun
stopWorkflowStage(run): WorkflowRun
```

## Data Flow

API route input becomes a `WorkflowRun`, then `advanceWorkflow` creates or consumes artifacts and approval gates until the run reaches a terminal or waiting state.

## Dependencies

- Internal: `repos/jormungand/lib/types.ts`, `repos/jormungand/lib/agents.ts`, `repos/jormungand/lib/runtime-skills.ts`
- External: configured agent bridge through callback injection

## Testing Notes

Workflow behavior is covered by `repos/jormungand/tests/workflow.test.ts`.

## Wiki Cross-References

- [[wiki/entities/workflow-engine]]
- [[wiki/c4/container]]
