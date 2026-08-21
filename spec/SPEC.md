---
title: jormungand-system-spec
type: spec
module: system
visibility: external
created: 2026-08-11
updated: 2026-08-21
---

# Jormungand System Specification

## Overview

Jormungand is a Next.js harness framework for managing project workflow
runs across human approval gates and configurable agent executors. It
combines a browser dashboard with a public Agent2Agent (A2A) v0.3
surface, a SQLite-backed hive memory store, a manager-driven
workflow loop, and three families of agent bridge runtimes.

## Source of Truth

- Repository: `repos/jormungand/` app project; see [[repos/README]]
- UI: `repos/jormungand/app/` and `repos/jormungand/components/`
- Domain/runtime logic: `repos/jormungand/lib/`
- Scripts: `repos/jormungand/scripts/`
- Tests: `repos/jormungand/tests/`

## Architecture

The system has the following main containers:

- Harness Dashboard — browser UI, the only frontend surface.
- Next.js API Routes — workflow, conversation, A2A, health, and
  metadata endpoints.
- Workflow Engine — stage state machine, approval gates, and
  artifact production.
- Agent Bridge — single chokepoint that dispatches to the three
  configured executor families.
- Workspace Store — JSON-backed projects and workflow runs.
- Hive Memory — SQLite (WAL) store for memories, conversations,
  A2A audit trail, manager state, and execution-job queue.
- Manager Scheduler — durable loop that drives managed runs
  (`hive_mission`, `arceus_maintenance`) via the execution-job queue.
- Runtime Skill Resolver — selects runtime skill bundles from the
  Superpowers catalog against the harness lockfile.
- A2A Server — public v0.3 JSON-RPC surface for external agents.
- Bridge Runtimes — three external Node processes: Codex bridge
  (port 4177), OpenClaw bridge (port 4188), minimax bridge
  (port 3002).

The canonical C4 model is `wiki/c4/workspace.dsl`.

## Agent Bridges

The system ships three families of agent bridge, each implemented as a
standalone Node HTTP server under `repos/jormungand/scripts/`:

- **Codex bridge** (`codex-bridge.mjs`) — spawns the Codex CLI inside
  the operator workspace, or runs a `minimax` executor path against
  an OpenAI-compatible backend or local command.
- **OpenClaw bridge** (`openclaw-bridge.mjs`) — spawns the
  OpenClaw CLI inside a Docker container, maintains a per-run
  journal, and exposes a live-events SSE surface.
- **minimax bridge** (`minimax-bridge.mjs`) — thin OpenAI-compatible
  proxy; POSTs to a configured backend URL or spawns a local
  command with the prompt on stdin.

All three speak `harness-agent-bridge/v0.2` or `v0.3` and expose at
least `GET /health`, `POST /agent-runs`, and
`GET /agent-runs/by-idempotency/:key`. The protocol v0.3 wire shape
is required when runtime skill bundles are present.

## API Surface

Workflow and project endpoints:

- `repos/jormungand/app/api/workflow-runs/route.ts`: list and create
  workflow runs.
- `repos/jormungand/app/api/workflow-runs/[id]/route.ts`: inspect a
  workflow run.
- `repos/jormungand/app/api/workflow-runs/[id]/advance/route.ts`:
  advance workflow state.
- `repos/jormungand/app/api/workflow-runs/[id]/cancel/route.ts`:
  cancel a workflow run.
- `repos/jormungand/app/api/workflow-runs/[id]/stop/route.ts`: stop
  a workflow stage.
- `repos/jormungand/app/api/workflow-runs/[id]/conversation/route.ts`:
  read and post to a run's conversation.
- `repos/jormungand/app/api/workflow-runs/[id]/manager/wake/route.ts`:
  enqueue a `manager_wake` execution job.
- `repos/jormungand/app/api/workflow-runs/[id]/manager/message/route.ts`:
  append a manager operator message and enqueue an
  `operator_message` wake.
- `repos/jormungand/app/api/workflow-runs/[id]/manager/replan/route.ts`:
  reduce budget and enqueue a `mission_amended` wake.
- `repos/jormungand/app/api/workflow-runs/[id]/manager/pause/route.ts`:
  pause a managed run.
- `repos/jormungand/app/api/approval-gates/[id]/decide/route.ts`:
  decide approval gates.
- `repos/jormungand/app/api/projects/route.ts`: list and create
  projects.
- `repos/jormungand/app/api/projects/[id]/workflow-runs/route.ts`:
  create a workflow run for an existing project.

Conversation endpoints:

- `repos/jormungand/app/api/conversations/route.ts` and
  `repos/jormungand/app/api/conversations/[id]/route.ts`: list,
  create, rename, archive, and delete conversations.
- `repos/jormungand/app/api/conversation/route.ts`: post a message
  to the bound conversation.
- `repos/jormungand/app/api/conversation/live/route.ts`: SSE stream
  of `agent-live` events.
- `repos/jormungand/app/api/conversation/control/route.ts`:
  Codex-specific interrupt/resume/stop controls.

A2A v0.3 endpoints (public; Bearer or Basic auth):

- `repos/jormungand/app/.well-known/agent-card.json/route.ts`:
  public discovery document.
- `repos/jormungand/app/api/a2a/route.ts`: JSON-RPC 2.0
  `message/send` and `message/stream`.
- `repos/jormungand/app/api/a2a/tasks/[id]/route.ts`: read a
  normalized task projection; cancel a task.
- `repos/jormungand/app/api/a2a/audit/[id]/route.ts`: redacted
  task, request/response frames, hashes, audit timeline.

Health and metadata endpoints:

- `repos/jormungand/app/health/route.ts`: public application
  liveness; bypasses auth.
- `repos/jormungand/app/api/agent-health/route.ts`: authenticated
  bridge health checks.
- `repos/jormungand/app/api/agent-quotas/route.ts`: Codex and
  OpenClaw quota snapshots.
- `repos/jormungand/app/api/superpowers-skills/route.ts`: list
  the local Superpowers skill catalog.
- `repos/jormungand/app/api/hive-memory/health/route.ts`:
  schema version, db path, workflow state status, last backup,
  integrity result.

## A2A v0.3 Public Surface

Jormungand exposes a public Agent2Agent v0.3 surface for discovery,
JSON-RPC task submission, task reads, cancellation, and local audit
reconstruction. This implementation is intentionally v0.3 only; it
does not advertise v1 methods or schemas.

- `GET /.well-known/agent-card.json` — public discovery document.
  No auth required.
- `POST /api/a2a` — JSON-RPC 2.0 `message/send` and
  `message/stream`.
- `GET|POST /api/a2a/tasks/:id` — read or cancel a task.
- `GET /api/a2a/audit/:id` — redacted audit record with SHA-256
  hashes and an ordered lifecycle timeline.

When `JORMUNGAND_A2A_TOKEN` is set, the JSON-RPC and task/audit
routes require `Authorization: Bearer <token>`. When the token is
unset, the same routes fall back to site Basic Auth. Bearer and
Basic are never simultaneously required on the same `Authorization`
header.

Normalized task states are `submitted`, `working`,
`input-required`, `completed`, `failed`, `canceled`, and `unknown`.
`unknown` is an explicit recovery state, not a successful
completion.

Every inbound A2A frame is redacted before storage. Keys matching
`authorization`, `token`, `password`, `secret`, `cookie`, or
`site_auth` are replaced with `[REDACTED]`, and `Bearer …` strings
and `key=value` secret fragments inside strings are rewritten.

## Hive Memory Operations

Hive memory, manager checkpoints, and task conversation entries are
persisted in a single SQLite database opened in WAL mode
(`PRAGMA journal_mode=WAL`, `foreign_keys=ON`,
`busy_timeout=5000`). The schema is at version 6 with six numbered
migrations under `repos/jormungand/lib/hive-memory/schema.ts`:

- v1 — `hive_events`, `memories` (with FTS5), `memory_sources`,
  `memory_evidence`, `memory_candidates`, `memory_uses`,
  `memory_conflicts`, `agent_identities`, `manager_decisions`,
  `manager_checkpoints`, `manager_tasks`, `manager_wakes`,
  `conversation_entries`.
- v2 — `codex_sessions` (conversation ↔ bridge session / thread /
  cursor).
- v3 — `conversations` (id, title, state); backfill from
  `conversation_entries`.
- v4 — `a2a_tasks`, `a2a_messages`, `a2a_events`.
- v5 — `conversation_entries.recipient_agent` column.
- v6 — `execution_jobs` table with a claimable durable job queue.

Production must set `JORMUNGAND_DATA_DIR=/data` and mount a
provider-managed persistent volume at that directory. Both the
SQLite database and `harness-state.json` live under the same data
directory, so volume-level backups must carry the pair together.

Backups are produced by `npm run memory:backup`, which copies the
live SQLite via the online backup API, switches the copy to
`journal_mode = DELETE`, runs `PRAGMA integrity_check`, copies
`harness-state.json` to a paired `<timestamp>.state.json` file,
and prunes to the latest 14 timestamped pairs. `npm run
memory:verify-backup -- <backup.sqlite>` restores the pair into a
fresh `os.tmpdir()` directory and never touches the live database.

`/api/hive-memory/health` returns the schema version, db path,
workflow state status, latest backup time, and the latest
integrity result. If startup or health reports `unavailable`,
autonomous managed work must stop until the database and JSON
state are restored from a verified backup.

## Manager Scheduler and Execution Jobs

The `ManagerScheduler` (`repos/jormungand/lib/manager-scheduler.ts`)
drives managed runs such as `hive_mission` and
`arceus_maintenance`. It holds per-`workflowRunId` in-process
locks, tracks `callsUsed`, `timeLimitMs`, and `costUsedUsd` against
budget, and applies manager actions including `create_task`,
`retry_task`, `pause_task`, `stop_task`, `reassign_task`,
`dispatch_task`, `request_approval`, and `request_review`. Each
action writes a `manager_decisions` row and updates the
`manager_checkpoints` history.

Managed runs are durable. The `execution_jobs` table (v6) is a
claimable queue: `runNextExecutionJob` claims the next pending
job, runs a kind-specific handler, then marks the job completed
or failed. Lease expiry is enforced. The HTTP route handler
returns `202` for queued/running, `200` for completed, `500` for
failed, and `409` for canceled.

## Agent Permission Mode

`JORMUNGAND_AGENT_PERMISSION_MODE` selects the shared full-access
or restricted agent permission contract:

- `full` (default) — the Codex bridge passes
  `--dangerously-bypass-approvals-and-sandbox` to the Codex CLI
  and drops `--sandbox workspace-write`. Workflow approval gates
  auto-pass. Manager `request_approval` actions are recorded in
  the audit log without parking the run.
- `restricted` — Codex uses the standard `--sandbox workspace-write`
  flag. Workflow approval gates park the run at
  `waiting_for_approval`. Manager `request_approval` actions park
  the run.

Site Basic Auth and bridge tokens are not affected by the
permission mode. Frontend validation is not an authorization
boundary; server-side authentication, bridge tokens, conversation
audit/history, and the permission mode still apply.

## Runtime Skills and Superpowers Catalog

The runtime skill resolver (`repos/jormungand/lib/runtime-skills.ts`)
reads `.harness/skill-registry.json` and `.harness/skill.lock.json`
to decide which runtime skill bundles can be installed into a
bridge executor. The Superpowers catalog is cloned from the
private `linderwu/jormungand_skill` repository with a 6-hour cache
(`repos/jormungand/lib/superpowers-catalog.ts`). The
`JORMUNGAND_SKILL_REPOSITORY_TOKEN` is passed to Git through an
authorization header and is never embedded in the repository URL.

## Configuration

Important environment variables include:

- `JORMUNGAND_DATA_DIR` — root for SQLite, JSON state, and
  backups. Production must set this to a persistent volume.
- `JORMUNGAND_AGENT_PERMISSION_MODE` — `full` or `restricted`.
- `JORMUNGAND_A2A_TOKEN` — enables Bearer auth on A2A routes.
- `JORMUNGAND_SKILL_REPOSITORY_URL` and
  `JORMUNGAND_SKILL_REPOSITORY_TOKEN` — private Superpowers
  catalog source.
- `JORMUNGAND_REPOSITORY` — repository for `arceus_maintenance`
  projects.
- `JORMUNGAND_RECORD_REPOSITORY` — destination for `agent_task`
  response records.
- `SITE_AUTH_USERNAME`, `SITE_AUTH_PASSWORD`, `SITE_AUTH_MODE` —
  site Basic Auth.
- `CODEX_BRIDGE_URL`, `CODEX_BRIDGE_TOKEN`,
  `CODEX_BRIDGE_PROTOCOL_VERSION`, `CODEX_BRIDGE_RUNTIME_SKILLS` —
  Codex bridge.
- `OPENCLAW_BRIDGE_URL`, `OPENCLAW_BRIDGE_TOKEN`,
  `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_A2A_COMMAND`,
  `OPENCLAW_A2A_PROTOCOL`, `OPENCLAW_A2A_MODEL`,
  `OPENCLAW_DOCKER_COMMAND`, `OPENCLAW_CONTAINER` — OpenClaw
  bridge and A2A fallback.
- `MINIMAX_BRIDGE_URL`, `MINIMAX_BRIDGE_TOKEN`,
  `MINIMAX_GATEWAY_TOKEN`, `MINIMAX_BACKEND_URL`,
  `MINIMAX_BACKEND_COMMAND`, `MINIMAX_A2A_COMMAND` — minimax
  bridge and A2A fallback.
- `HARNESS_BRIDGE_TOKEN` — shared fallback for any bridge.
- `HARNESS_ALLOW_SIMULATED_AGENTS` — enables the simulated
  executor path.

## Security Considerations

Bridge tokens and runtime credentials must remain outside git.
`.env.local`, `.env`, and secret directories are not part of the
Ouroboros evidence layer unless explicitly sanitized and recorded
as non-secret configuration evidence.

`SITE_AUTH_MODE` defaults to `all`. The HTTP boundary protects the
UI and API; only `/health` bypasses site authentication. A2A
routes require Bearer auth when `JORMUNGAND_A2A_TOKEN` is set,
otherwise site Basic Auth applies. Bridge health endpoints use
Bearer authentication, and their tokens are independent from the
dashboard Basic Auth credentials.

Site Basic Auth counts every failed protected request per source
IP, including missing or malformed `Authorization` headers. After
five consecutive failures, that IP remains locked until the
service restarts. The lockout state is in-memory and per-process;
there is no manual unlock endpoint.

A2A audit frames are redacted before persistence. Any key matching
`authorization`, `token`, `password`, `secret`, `cookie`, or
`site_auth` is replaced with `[REDACTED]`, and `Bearer …` strings
and `key=value` secret fragments inside strings are rewritten.

## Production Deployment Contract

- Zeabur serves the nested `repos/jormungand/` Next.js application.
- Codex, OpenClaw, and minimax bridges all use authenticated
  bridge protocol v0.3 (v0.2 accepted for Codex only when no
  runtime skill bundles are configured).
- The OpenClaw public hostname terminates at a tunnel that
  forwards to the VM user bridge service on loopback port 4178.
- The OpenClaw deployment synchronizes a VM-local exact
  runtime-skill lockfile.
- Project and workflow state remains JSON-backed and
  container-local unless an external persistent volume is
  configured. Hive memory requires a persistent volume and the
  paired state must be backed up together.

## Acceptance Criteria

- Ouroboros layers exist: `raw/`, `repos/`, `graphify/`, `wiki/`,
  `spec/`.
- Code graph evidence exists under `graphify/jormungand-root/`.
- C4 source exists at `wiki/c4/workspace.dsl`.
- Core module specs exist for workflow, agent bridge, and
  workspace store.
- Wiki pages cite raw evidence and code/graph sources.
- Generated C4 outputs include both local and production
  deployment views.
- Public `/health` and protected `/api/agent-health` have
  distinct contracts.
- A2A v0.3 surface serves `/.well-known/agent-card.json` and the
  JSON-RPC / task / audit routes with consistent Bearer or
  Basic auth behavior.
- Hive memory runs in WAL mode with paired backup and verification
  scripts; `/api/hive-memory/health` reports schema version and
  integrity status.
- Manager scheduler supports the durable `execution_jobs` queue
  and the managed project types `hive_mission` and
  `arceus_maintenance`.
- Agent permission mode `full`/`restricted` affects Codex flags,
  workflow approval gates, and manager `request_approval` actions
  consistently across the bridges and the workflow engine.

## References

- [[raw/2026-08-11-user-request-ouroboros-application]]
- [[raw/2026-08-11-ouroboros-skill-source]]
- [[raw/2026-08-13-secure-bridge-deployment-verification]]
- [[raw/2026-08-21-wiki-spec-refresh]]
- [[wiki/index]]
