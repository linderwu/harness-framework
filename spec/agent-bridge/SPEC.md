---
title: agent-bridge-spec
type: spec
module: agent-bridge
visibility: internal
created: 2026-08-11
updated: 2026-08-11
---

# Agent Bridge

## Summary

The agent bridge adapts workflow agent invocations to Codex bridge, OpenClaw bridge, OpenClaw A2A command, manual, or simulated execution modes.

## Source of Truth

- Primary path: `repos/jormungand/lib/agent-bridge.ts`
- A2A helper: `repos/jormungand/lib/a2a-protocol.ts`
- Agent profiles: `repos/jormungand/lib/agents.ts`
- Entity: [[wiki/entities/agent-bridge]]

## Construction Blueprint

### Core Features

- Select executor family from `AgentKind`.
- Enforce bridge protocol compatibility for runtime skill bundles.
- Build idempotent bridge requests.
- Normalize bridge responses into `AgentArtifactResult`.
- Send cancel/stop controls to configured bridge URLs.
- Support OpenClaw A2A stdin/stdout command execution.

### Inputs

- `AgentInvocationInput`
- environment bridge configuration
- workflow run and skill metadata

### Outputs

- `AgentArtifactResult`
- optional external run id and idempotency key
- normalized artifacts and runtime skill bundle results

### Side Effects

- HTTP requests to Codex/OpenClaw bridge URLs.
- Child process execution for OpenClaw A2A command mode.
- GitHub repository readiness checks during intake.

## Interface

```ts
invokeConfiguredAgent(input): Promise<AgentArtifactResult | undefined>
cancelConfiguredAgentRun(run): Promise<void>
stopConfiguredAgentRun(run): Promise<void>
```

## Error Handling

Missing bridge configuration returns failed or simulated artifacts depending on `HARNESS_ALLOW_SIMULATED_AGENTS`.

## Testing Notes

Agent bridge behavior is indirectly covered through workflow and runtime skill tests. Add direct bridge contract tests when transport behavior changes.

## Wiki Cross-References

- [[wiki/entities/agent-bridge]]
- [[wiki/c4/container]]
