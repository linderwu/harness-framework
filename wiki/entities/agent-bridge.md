---
title: Agent Bridge
type: entity
tags: [agent-runtime, codex, openclaw, bridge]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Agent Bridge

## Summary

The agent bridge translates workflow-stage requests into configured Codex bridge, OpenClaw bridge, OpenClaw A2A, or manual/simulated execution behavior.

## Responsibility Boundaries

- Owns executor transport selection and request/response normalization.
- Owns bridge protocol compatibility checks.
- Does not decide workflow stage semantics.

## Source

- Primary path: `repos/jormungand/lib/agent-bridge.ts`
- A2A protocol helper: `repos/jormungand/lib/a2a-protocol.ts`
- Agent profiles: `repos/jormungand/lib/agents.ts`
- Spec: [[spec/agent-bridge/SPEC]]
- Repository layer: [[repos/README]]

## Procedural Position

[[wiki/entities/workflow-engine]] invokes the agent bridge when an event skill must produce an artifact through an external or simulated executor.

## References

- [[raw/2026-08-11-graphify-code-only-run]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
