---
title: Jormungand Container View
type: c4
tags: [architecture, c4, container]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Jormungand Container View

## View

Canonical Structurizr view key: `container`

## Containers

- Harness Dashboard: `repos/jormungand/components/harness-dashboard.tsx` and `repos/jormungand/app/page.tsx`.
- Next.js API Routes: `repos/jormungand/app/api/**/route.ts`.
- Workflow Engine: `repos/jormungand/lib/workflow.ts`.
- Agent Bridge: `repos/jormungand/lib/agent-bridge.ts`.
- Workspace Store: `repos/jormungand/lib/store.ts` and `repos/jormungand/lib/workspace.ts`.
- Runtime Skill Resolver: `repos/jormungand/lib/runtime-skills.ts`.

## Generated Diagrams

- `wiki/c4/diagrams/container.mmd`
- `wiki/c4/diagrams/container.svg`

## Graph Evidence

Graphify identified `advanceWorkflow()`, `invokeConfiguredAgent()`, `WorkflowRun`, and `getAgentProfile()` as central abstractions in the code graph. See [[raw/2026-08-11-graphify-code-only-run]] and `graphify/jormungand-root/GRAPH_REPORT.md`.

## Notes

The model follows codebase-MCP-first discovery, then graphify output. `wiki/c4/workspace.dsl` remains the source of truth, and generated diagrams are required completion artifacts.
