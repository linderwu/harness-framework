---
title: Harness Dashboard
type: entity
tags: [frontend, nextjs, dashboard]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Harness Dashboard

## Summary

The Harness Dashboard is the browser-facing Next.js UI for creating projects, starting workflow runs, inspecting artifacts, and handling approval gates.

## Responsibility Boundaries

- Owns workflow visibility and user interaction.
- Does not directly execute agent work; execution is delegated through the workflow engine and agent bridge.

## Source

- Primary UI: `components/harness-dashboard.tsx`
- App entry: `app/page.tsx`
- Root-local exception: [[wiki/concepts/root-local-code-exception]]
- Spec: [[spec/SPEC]]

## Procedural Position

User input flows from the dashboard to API routes, then into [[wiki/entities/workflow-engine]] and [[wiki/entities/agent-bridge]] when an agent executor is selected.

## References

- [[raw/2026-08-11-user-request-ouroboros-application]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
