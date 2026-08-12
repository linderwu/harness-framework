---
title: Jormungand Component Views
type: c4
tags: [architecture, c4, component]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Jormungand Component Views

## View

Canonical Structurizr view keys:

- `componentDashboard`
- `componentApiRoutes`
- `componentWorkflowEngine`
- `componentAgentBridge`
- `componentWorkspaceStore`
- `componentRuntimeSkillResolver`

## Summary

The component views split the main containers into their durable responsibilities:
UI composition and run controls, HTTP route ownership, workflow state transitions,
agent execution normalization, JSON-backed persistence, and runtime skill bundle
resolution.

## Generated Diagrams

- `wiki/c4/diagrams/component-dashboard.mmd`
- `wiki/c4/diagrams/component-dashboard.svg`
- `wiki/c4/diagrams/component-api-routes.mmd`
- `wiki/c4/diagrams/component-api-routes.svg`
- `wiki/c4/diagrams/component-workflow-engine.mmd`
- `wiki/c4/diagrams/component-workflow-engine.svg`
- `wiki/c4/diagrams/component-agent-bridge.mmd`
- `wiki/c4/diagrams/component-agent-bridge.svg`
- `wiki/c4/diagrams/component-workspace-store.mmd`
- `wiki/c4/diagrams/component-workspace-store.svg`
- `wiki/c4/diagrams/component-runtime-skill-resolver.mmd`
- `wiki/c4/diagrams/component-runtime-skill-resolver.svg`

## Evidence

- `repos/jormungand/components/harness-dashboard.tsx`
- `repos/jormungand/app/api/**/route.ts`
- `repos/jormungand/lib/workflow.ts`
- `repos/jormungand/lib/agent-bridge.ts`
- `repos/jormungand/lib/store.ts`
- `repos/jormungand/lib/workspace.ts`
- `repos/jormungand/lib/runtime-skills.ts`
- `graphify/jormungand-root/GRAPH_REPORT.md`
