---
title: Wiki and Spec Refresh Trigger
type: raw
date: 2026-08-21
status: active
tags: [wiki, spec, ouroboros, refresh]
---

# Wiki and Spec Refresh Trigger

## Trigger

After exploring the Jormungand Next.js application to understand how the
codebase works, the maintainer noticed the curated wiki and the
construction contract (`spec/SPEC.md`) had not been updated since
2026-08-13. The Trivium knowledge architecture requires `wiki/` and
`spec/` to track the current system; otherwise decision memory drifts
from implementation.

## Stale Areas Found

- `spec/SPEC.md` is missing the following subsystems that are now in
  production code:
  - A2A v0.3 public surface (`.well-known/agent-card.json`,
    `POST /api/a2a`, `GET|POST /api/a2a/tasks/:id`,
    `GET /api/a2a/audit/:id`).
  - Hive memory (SQLite WAL, 6 schema migrations, online backup
    verification, `harness-state.json` paired state).
  - Manager scheduler (`ManagerScheduler`) and the durable
    `execution_jobs` table.
  - The `minimax` bridge (only Codex and OpenClaw were listed).
  - The agent permission mode (`JORMUNGAND_AGENT_PERMISSION_MODE` =
    `full` | `restricted`) and its effect on Codex flags, workflow
    approval gates, and manager `request_approval` actions.
  - The conversation service and the Codex session protocol.
  - The Superpowers skill catalog refresh path
    (`linderwu/jormungand_skill.git`).
- `wiki/index.md` linked only the original four entities. New
  entities such as the A2A server, hive memory, manager scheduler,
  execution jobs, runtime-skill resolver, and superpowers catalog are
  not yet curated pages.
- `wiki/concepts/` held only three entries; the agent permission
  mode, the per-IP lockout, the A2A redaction rules, and the
  idempotency-key pattern are documented only in code today.
- `wiki/patterns/` held a single entry; the optimistic concurrency
  pattern, the redaction pattern, and the live-event relay pattern
  are reusable but uncaptured.
- `wiki/c4/diagrams/` was last regenerated on 2026-08-13 and does not
  show the A2A, hive memory, or manager scheduler components.
- `graphify/jormungand-root/` and `graphify-out/` were both
  regenerated on 2026-08-13.

## Decision

Apply a **quick refresh** in this cycle:

- Rewrite `spec/SPEC.md` so it accurately describes the A2A, hive
  memory, manager scheduler, minimax bridge, and permission mode
  subsystems.
- Add inline notes inside the four existing entity pages
  (`agent-bridge`, `workflow-engine`, `workspace-store`,
  `harness-dashboard`) about the new adjacent subsystems, with
  pointers to the code that owns them.
- Update `wiki/index.md` to reference the new spec sections and
  to flag that full entity/concept/pattern pages for the new
  subsystems are deferred to a follow-up cycle.

Out of scope for this cycle (deferred):

- Adding new top-level entity pages for A2A, hive memory, manager
  scheduler, execution jobs, runtime-skill resolver, and
  superpowers catalog.
- Adding new concept and pattern pages.
- Regenerating the C4 diagrams (`npm run c4:diagrams`) — requires
  the local toolchain and a deliberate diagram-redesign pass.
- Regenerating the relationship graphs under `graphify/` and
  `graphify-out/` — also requires the toolchain.

The follow-up cycle should land the new entity/concept/pattern
pages and the regenerated diagrams, and should add a fresh raw
note for that cycle.

## Affected Files

- `raw/2026-08-21-wiki-spec-refresh.md` (this file).
- `spec/SPEC.md` — rewrite.
- `wiki/index.md` — link updates.
- `wiki/entities/agent-bridge.md` — add minimax bridge and
  permission-mode notes.
- `wiki/entities/workflow-engine.md` — add manager scheduler and
  execution jobs notes.
- `wiki/entities/workspace-store.md` — add hive memory notes.
- `wiki/entities/harness-dashboard.md` — add conversation panel
  and live event feed notes.

## References

- `repos/jormungand/README.md` — operator manual with A2A v0.3
  contract and hive memory operations.
- `repos/jormungand/lib/a2a-{protocol,runtime,server,route-handlers}.ts`
  — A2A stack.
- `repos/jormungand/lib/hive-memory/` — SQLite store, schema,
  repository, governance.
- `repos/jormungand/lib/manager-scheduler.ts` and
  `repos/jormungand/lib/managed-workflows.ts` — manager loop.
- `repos/jormungand/lib/execution-jobs.ts` and
  `repos/jormungand/lib/execution-job-runner.ts` — durable job
  queue.
- `repos/jormungand/scripts/minimax-bridge.mjs` — minimax bridge
  server.
- `repos/jormungand/lib/agent-permissions.ts` and
  `repos/jormungand/scripts/agent-permissions.mjs` — permission
  mode.
- `repos/jormungand/lib/superpowers-catalog.ts` and
  `repos/jormungand/lib/runtime-skills.ts` — skill catalog.
- `repos/jormungand/lib/conversation*.ts` and
  `repos/jormungand/lib/codex-conversation.ts` — conversation
  service.
