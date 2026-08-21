---
title: Workspace Store
type: entity
tags: [persistence, workspace, json-state, hive-memory, sqlite]
status: active
created: 2026-08-11
updated: 2026-08-21
---

# Workspace Store

## Summary

The workspace store persists projects, workflow runs, artifacts, approval gates, warnings, and normalized workspace state in a single JSON file. It is paired with hive memory, a SQLite (WAL) database that owns the rest of the durable state for the system; both live under the same configured data directory and share a paired backup contract.

## Responsibility Boundaries

- Owns JSON-backed workspace persistence and normalization.
- Does not own user interface behavior.
- Does not execute workflow stages.

## Source

- Store implementation: `repos/jormungand/lib/store.ts`
- Workspace normalization: `repos/jormungand/lib/workspace.ts`
- Data path resolution: `repos/jormungand/lib/data-paths.ts` and
  `repos/jormungand/lib/data-paths.mjs`
- Hive memory entry points: `repos/jormungand/lib/hive-services.ts`
  and `repos/jormungand/lib/hive-health.ts`
- Hive memory internals:
  `repos/jormungand/lib/hive-memory/{database,schema,types,repository,governance}.ts`
- Spec: [[spec/workspace/SPEC]]
- Repository layer: [[repos/README]]

## Procedural Position

API routes use the store to read/write workflow and project records around [[wiki/entities/workflow-engine]] operations. Conversation entries, memories, A2A audit records, manager state, and the durable `execution_jobs` queue do **not** live in this store; they live in hive memory and are accessed through `repos/jormungand/lib/hive-memory/repository.ts`.

In the production Zeabur topology the JSON store remains on the application
container filesystem unless an external persistent volume is configured. Its
single-process and durability limitations are explicitly governed by
[[wiki/concepts/tech-debt-json-state-persistence]]. Production must also
set `JORMUNGAND_DATA_DIR=/data` so the paired SQLite database and the
JSON state land on a provider-managed persistent volume; the backup scripts
under `repos/jormungand/scripts/backup-hive-memory.mjs` and
`repos/jormungand/scripts/verify-hive-memory-backup.mjs` carry the pair
together. The full hive memory contract is in [[spec/SPEC]]; a dedicated
entity page for hive memory is deferred to a follow-up cycle, see
[[raw/2026-08-21-wiki-spec-refresh]].

## References

- [[raw/2026-08-11-graphify-code-only-run]]
- [[raw/2026-08-13-secure-bridge-deployment-verification]]
- [[raw/2026-08-21-wiki-spec-refresh]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
