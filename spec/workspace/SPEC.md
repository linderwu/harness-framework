---
title: workspace-store-spec
type: spec
module: workspace
visibility: internal
created: 2026-08-11
updated: 2026-08-13
---

# Workspace Store

## Summary

The workspace layer creates projects, normalizes legacy workflow state, links projects to workflow runs, and exposes project overview data.

## Source of Truth

- Workspace logic: `repos/jormungand/lib/workspace.ts`
- Store persistence: `repos/jormungand/lib/store.ts`
- Types: `repos/jormungand/lib/types.ts`
- Entity: [[wiki/entities/workspace-store]]

## Construction Blueprint

### Core Features

- Create projects from templates.
- Normalize partial or legacy workspace state.
- Create legacy projects for workflow runs without project links.
- Refresh project artifact/run links.
- Compute project overview data for dashboard display.

### Inputs

- `CreateProjectInput`
- partial `HarnessState`
- `Project`
- `WorkflowRun[]`

### Outputs

- `Project`
- normalized `HarnessState`
- `ProjectOverview`

### Side Effects

`repos/jormungand/lib/workspace.ts` is pure state transformation. `repos/jormungand/lib/store.ts` owns persistence side effects.

The production store remains a single-process JSON file on the application
filesystem. It is not a multi-replica or disaster-recovery persistence
contract; see [[wiki/concepts/tech-debt-json-state-persistence]].

## Interface

```ts
createProject(input): Project
normalizeWorkspace(state): HarnessState
getProjectOverview(project, workflowRuns): ProjectOverview
refreshProjectAfterRun(project, workflowRuns): Project
```

## Testing Notes

Workspace behavior is covered by `repos/jormungand/tests/workspace-model.test.ts` and related project selector tests.

## Wiki Cross-References

- [[wiki/entities/workspace-store]]
- [[wiki/c4/container]]
