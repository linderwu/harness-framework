---
title: jormungand-system-spec
type: spec
module: system
visibility: external
created: 2026-08-11
updated: 2026-08-11
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
- `repos/jormungand/app/api/agent-health/route.ts`: configured agent health.

## Configuration

Important environment variables include:

- `CODEX_BRIDGE_URL`
- `CODEX_BRIDGE_TOKEN`
- `CODEX_BRIDGE_PROTOCOL_VERSION`
- `OPENCLAW_BRIDGE_URL`
- `OPENCLAW_BRIDGE_TOKEN`
- `OPENCLAW_A2A_COMMAND`
- `OPENCLAW_A2A_PROTOCOL`
- `OPENCLAW_A2A_MODEL`
- `HARNESS_ALLOW_SIMULATED_AGENTS`

## Security Considerations

Bridge tokens and runtime credentials must remain outside git. `.env.local`, `.env`, and secret directories are not part of the Ouroboros evidence layer unless explicitly sanitized and recorded as non-secret configuration evidence.

## Acceptance Criteria

- Ouroboros layers exist: `raw/`, `repos/`, `graphify/`, `wiki/`, `spec/`.
- Code graph evidence exists under `graphify/jormungand-root/`.
- C4 source exists at `wiki/c4/workspace.dsl`.
- Core module specs exist for workflow, agent bridge, and workspace store.
- Wiki pages cite raw evidence and code/graph sources.

## References

- [[raw/2026-08-11-user-request-ouroboros-application]]
- [[raw/2026-08-11-ouroboros-skill-source]]
- [[wiki/index]]
