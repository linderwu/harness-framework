---
title: Workflow Engine
type: entity
tags: [workflow, domain, runtime, manager, execution-jobs]
status: active
created: 2026-08-11
updated: 2026-08-21
---

# Workflow Engine

## Summary

The workflow engine creates workflow runs, advances stage state, records artifacts, opens approval gates, and routes agent tasks through configured executors. Managed project types (`hive_mission`, `arceus_maintenance`) are driven by the manager scheduler via the durable `execution_jobs` queue rather than by inline `advanceWorkflow` calls.

## Responsibility Boundaries

- Owns workflow state transitions and artifact/gate creation.
- Does not own persistent storage implementation.
- Does not own external agent transport details.

## Project-Type Semantics

`agent_task` is a distinct one-stage execution path. Research, Development,
Testing, Documentation, Diagnosis, and Decision currently provide different
project templates and phase labels but share the same default workflow event
skill chain. Template creation was verified independently from real bridge
workflow execution; see
[[raw/2026-08-13-secure-bridge-deployment-verification]].

The two managed project types, `hive_mission` and `arceus_maintenance`,
follow a different lifecycle: project creation seeds a `managedConfig`,
every workflow run for the project is a durable `execution_jobs` row,
and the manager scheduler (`repos/jormungand/lib/manager-scheduler.ts`)
applies manager actions until the run is complete, parked for
approval, paused, or failed. Inline `advanceWorkflow` is not used for
managed runs.

## Source

- Primary path: `repos/jormungand/lib/workflow.ts`
- Types: `repos/jormungand/lib/types.ts`
- Managed workflows: `repos/jormungand/lib/managed-workflows.ts`
- Manager scheduler: `repos/jormungand/lib/manager-scheduler.ts`
- Hive manager: `repos/jormungand/lib/hive-manager.ts`
- Execution-job queue: `repos/jormungand/lib/execution-jobs.ts` and
  `repos/jormungand/lib/execution-job-runner.ts`
- Context builder: `repos/jormungand/lib/context-builder.ts`
- Project templates: `repos/jormungand/lib/project-templates.ts`
- Agent permission mode: `repos/jormungand/lib/agent-permissions.ts`
- Spec: [[spec/workflow/SPEC]]
- Repository layer: [[repos/README]]

## Procedural Position

API routes call workflow functions. The workflow engine calls [[wiki/entities/agent-bridge]] for agent execution and [[wiki/entities/workspace-store]] for persistence through route-level orchestration.

For managed runs, the workflow engine yields control to the manager scheduler, which claims `execution_jobs` rows, builds a context pack, and applies manager actions against [[wiki/entities/agent-bridge]]. Manager state, checkpoints, and wake history live in hive memory; see [[wiki/entities/workspace-store]] for the paired backup contract.

## References

- [[raw/2026-08-11-graphify-code-only-run]]
- [[raw/2026-08-13-graphify-deep-minimax-run]]
- [[raw/2026-08-21-wiki-spec-refresh]]
- [[wiki/concepts/tech-debt-synchronous-bridge-transport]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
