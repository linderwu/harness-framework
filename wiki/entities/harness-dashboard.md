---
title: Harness Dashboard
type: entity
tags: [frontend, nextjs, dashboard, conversation, sse]
status: active
created: 2026-08-11
updated: 2026-08-21
---

# Harness Dashboard

## Summary

The Harness Dashboard is the browser-facing Next.js UI for creating projects, starting workflow runs, inspecting artifacts, and handling approval gates. It also renders the persistent conversation panel, subscribes to the `agent-live` SSE feed, polls bridge health and quota metadata, and shows the manager-driven progress for managed runs.

## Responsibility Boundaries

- Owns workflow visibility and user interaction.
- Does not directly execute agent work; execution is delegated through the workflow engine and agent bridge.

## Source

- Primary UI: `repos/jormungand/components/harness-dashboard.tsx`
- Conversation panel: `repos/jormungand/components/task-conversation.tsx`
- Sidebar: `repos/jormungand/components/task-status-sidebar.tsx`
- Top nav: `repos/jormungand/components/global-mode-nav.tsx`
- App entry: `repos/jormungand/app/page.tsx`
- Live event SSE: `repos/jormungand/app/api/conversation/live/route.ts`
- Repository layer: [[repos/README]]
- Spec: [[spec/SPEC]]

## Procedural Position

User input flows from the dashboard to API routes, then into [[wiki/entities/workflow-engine]] and [[wiki/entities/agent-bridge]] when an agent executor is selected. The conversation panel subscribes to `/api/conversation/live`, which tails the in-process `agentLiveBus` that [[wiki/entities/agent-bridge]]'s OpenClaw live-event relay publishes into. The dashboard is a peer surface to the public A2A v0.3 surface; both share site Basic Auth, but the A2A surface also accepts Bearer when `JORMUNGAND_A2A_TOKEN` is set, as documented in [[spec/SPEC]].

## References

- [[raw/2026-08-11-user-request-ouroboros-application]]
- [[raw/2026-08-21-wiki-spec-refresh]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
