---
title: agent-bridge-spec
type: spec
module: agent-bridge
visibility: internal
created: 2026-08-11
updated: 2026-08-13
---

# Agent Bridge

## Summary

The agent bridge adapts workflow agent invocations to device bridges. The Codex
device bridge serves both Codex and Mavis/Lucky, while the OpenClaw device
bridge serves the concrete OpenClaw agents. OpenClaw A2A command and explicit
simulated execution remain compatibility modes.

## Source of Truth

- Primary path: `repos/jormungand/lib/agent-bridge.ts`
- A2A helper: `repos/jormungand/lib/a2a-protocol.ts`
- Agent profiles: `repos/jormungand/lib/agents.ts`
- Codex HTTP bridge: `repos/jormungand/scripts/codex-bridge.mjs`
- OpenClaw HTTP bridge: `repos/jormungand/scripts/openclaw-bridge.mjs`
- OpenClaw deployment: `repos/jormungand/scripts/deploy-openclaw-bridge.ps1`
- Runtime-skill allowlist: `repos/jormungand/.harness/skill.lock.json`
- Entity: [[wiki/entities/agent-bridge]]

## Construction Blueprint

### Core Features

- Resolve each logical executor to its device bridge; Codex and Mavis share
  `CODEX_BRIDGE_URL`.
- Enforce bridge protocol compatibility for runtime skill bundles.
- Require authenticated health and agent-run requests on non-loopback bridges.
- Build idempotent bridge requests.
- Normalize bridge responses into `AgentArtifactResult`.
- Send cancel/stop controls to configured bridge URLs.
- Support OpenClaw A2A stdin/stdout command execution.
- Reject a Codex request before execution when its requested GitHub repository
  does not match the configured workspace origin.
- Require OpenClaw runtime bundles to exactly match the deployed VM-local
  lockfile by id, version, source URL, and SHA-256 checksum.

### Inputs

- `AgentInvocationInput`
- environment bridge configuration
- workflow run and skill metadata

### Outputs

- `AgentArtifactResult`
- optional external run id and idempotency key
- normalized artifacts and runtime skill bundle results

### Side Effects

- HTTP requests to the Codex/OpenClaw device bridge URLs.
- Child process execution for OpenClaw A2A command mode.
- GitHub repository readiness checks during intake.
- Runtime bundle download, checksum verification, extraction, and installation
  by bridge processes.
- OpenClaw skill-directory copy into the configured Docker container.

## Interface

```ts
invokeConfiguredAgent(input): Promise<AgentArtifactResult>
cancelConfiguredAgentRun(run): Promise<void>
stopConfiguredAgentRun(run): Promise<void>
```

## Error Handling

Missing bridge configuration returns failed or simulated artifacts depending on `HARNESS_ALLOW_SIMULATED_AGENTS`.

Protocol mismatch and repository-origin mismatch fail before executor launch.
OpenClaw rejects descriptors outside the local lockfile as `bundle_not_locked`.
Bridge authentication accepts the dedicated bridge token first; the OpenClaw
gateway-token fallback exists only for compatibility. New deployments should
prefer a separate bridge token.

## Contract Verification Matrix

| Contract | Implementation invariant | Verification | Visibility |
| --- | --- | --- | --- |
| Bridge health is authenticated | Token check occurs before `/health` response | Security contract test and production unauthenticated probe | external |
| Codex health omits repository paths | Health payload contains protocol/capabilities only | Security contract test | external |
| Codex executes only its configured repository | Requested repository is matched against Git origin before `codex exec` | Repository mismatch contract test | external |
| OpenClaw installs only locked bundles | VM-local lock must exactly match descriptor and checksum | Negative `bundle_not_locked` smoke | external |
| Runtime skill protocol is v0.3 | Client and bridges reject unsupported versions | Workflow/runtime-skill tests | external |
| Site credentials stay outside OpenClaw VM | Deployment and bridge source do not transfer `SITE_AUTH_*` | Security contract test | internal |
| SSH deployment pins host identity | Persistent known_hosts plus strict checking | Deployment script contract test | internal |

## Testing Notes

Agent bridge behavior is covered by workflow/runtime-skill tests and direct
security contract tests in `repos/jormungand/tests/bridge-security.test.ts`.
Long-running transport remains synchronous; see
[[wiki/concepts/tech-debt-synchronous-bridge-transport]].

## Wiki Cross-References

- [[wiki/entities/agent-bridge]]
- [[wiki/c4/container]]
- [[wiki/c4/deployment]]
- [[raw/2026-08-13-secure-bridge-deployment-verification]]
