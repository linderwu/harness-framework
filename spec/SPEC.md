---
title: jormungand-system-spec
type: spec
module: system
visibility: external
created: 2026-08-11
updated: 2026-08-13
---

# Jormungand System Specification

## Overview

Jormungand is a Next.js harness framework for managing project workflow runs across human approval gates and configurable agent executors.

## Source of Truth

- Repository: `repos/jormungand/` app project; see [[repos/README]]
- UI: `repos/jormungand/app/` and `repos/jormungand/components/`
- Domain/runtime logic: `repos/jormungand/lib/`
- Scripts: `repos/jormungand/scripts/`
- Tests: `repos/jormungand/tests/`

## Architecture

The system has six main containers:

- Harness Dashboard
- Next.js API Routes
- Workflow Engine
- Agent Bridge
- Workspace Store
- Runtime Skill Resolver

The canonical C4 model is `wiki/c4/workspace.dsl`.

## API Surface

- `repos/jormungand/app/api/workflow-runs/route.ts`: list and create workflow runs.
- `repos/jormungand/app/api/workflow-runs/[id]/route.ts`: inspect a workflow run.
- `repos/jormungand/app/api/workflow-runs/[id]/advance/route.ts`: advance workflow state.
- `repos/jormungand/app/api/workflow-runs/[id]/cancel/route.ts`: cancel a workflow run.
- `repos/jormungand/app/api/workflow-runs/[id]/stop/route.ts`: stop a workflow stage.
- `repos/jormungand/app/api/approval-gates/[id]/decide/route.ts`: decide approval gates.
- `repos/jormungand/app/api/projects/route.ts`: project collection access.
- `repos/jormungand/app/api/projects/[id]/workflow-runs/route.ts`: project-scoped workflow creation.
- `repos/jormungand/app/health/route.ts`: public application liveness.
- `repos/jormungand/app/api/agent-health/route.ts`: authenticated configured
  bridge health.

## Configuration

Important environment variables include:

- `CODEX_BRIDGE_URL`
- `CODEX_BRIDGE_TOKEN`
- `CODEX_BRIDGE_PROTOCOL_VERSION`
- `OPENCLAW_BRIDGE_URL`
- `OPENCLAW_BRIDGE_TOKEN`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_A2A_COMMAND`
- `OPENCLAW_A2A_PROTOCOL`
- `OPENCLAW_A2A_MODEL`
- `HARNESS_ALLOW_SIMULATED_AGENTS`
- `SITE_AUTH_USERNAME`
- `SITE_AUTH_PASSWORD`
- `SITE_AUTH_MODE`

## Security Considerations

Bridge tokens and runtime credentials must remain outside git. `.env.local`,
`.env`, and secret directories are not part of the Ouroboros evidence layer
unless explicitly sanitized and recorded as non-secret configuration evidence.

`SITE_AUTH_MODE` defaults to `all`. The HTTP boundary protects the UI and API;
only `/health` bypasses site authentication. Bridge health endpoints use bearer
authentication, and their tokens are independent from the dashboard Basic Auth
credentials.

## Production Deployment Contract

- Zeabur serves the nested `repos/jormungand/` Next.js application.
- Codex and OpenClaw use authenticated bridge protocol v0.3.
- The OpenClaw public hostname terminates at a tunnel that forwards to the VM
  user bridge service on loopback port 4178.
- The OpenClaw deployment synchronizes a VM-local exact runtime-skill lockfile.
- Project/workflow state remains JSON-backed and container-local unless an
  external persistent volume is configured.

## Acceptance Criteria

- Ouroboros layers exist: `raw/`, `repos/`, `graphify/`, `wiki/`, `spec/`.
- Code graph evidence exists under `graphify/jormungand-root/`.
- C4 source exists at `wiki/c4/workspace.dsl`.
- Core module specs exist for workflow, agent bridge, and workspace store.
- Wiki pages cite raw evidence and code/graph sources.
- Generated C4 outputs include both local and production deployment views.
- Public `/health` and protected `/api/agent-health` have distinct contracts.

## References

- [[raw/2026-08-11-user-request-ouroboros-application]]
- [[raw/2026-08-11-ouroboros-skill-source]]
- [[raw/2026-08-13-secure-bridge-deployment-verification]]
- [[wiki/index]]
