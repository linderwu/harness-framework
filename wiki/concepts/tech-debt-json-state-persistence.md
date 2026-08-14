---
title: Technical Debt - Container-Local JSON State
type: concept
tags: [technical-debt, persistence, zeabur, reliability]
status: active
created: 2026-08-13
updated: 2026-08-13
---

# Technical Debt - Container-Local JSON State

## Summary

Jormungand persists projects and workflow runs in a JSON file under the running
application filesystem. This is appropriate for a single-process harness, but
the Zeabur container filesystem is not the durable system of record required by
a multi-replica or recovery-sensitive service.

## Context

- Goal: deploy the existing harness with working authenticated bridges.
- Constraint: changing persistence would expand the deployment into a database
  migration and operational project.
- Evidence: [[raw/2026-08-13-secure-bridge-deployment-verification]].

## Decision

Retain the JSON store for the current single-instance harness and document that
redeploy, reschedule, or concurrent writers can invalidate durability
assumptions.

## Debt Accepted

- State may not survive a container replacement unless an external volume is
  configured.
- The in-process write queue does not coordinate multiple replicas.
- The file is not a transactional database.

## Alternatives Considered

- Zeabur persistent volume: smaller migration, but still single-writer and
  platform-coupled.
- Managed relational database: durable and concurrent, but requires schema,
  migration, backup, and connection management.

## Repayment Trigger

Repay this debt before horizontal scaling, relying on run history for audit or
billing, accepting irreplaceable project data, or promising disaster recovery.

## Consequences

The production deployment is suitable as an operator harness, not yet as a
durable multi-tenant workflow database.

## Owner Or Review Surface

- [[wiki/entities/workspace-store]]
- [[spec/workspace/SPEC]]
- [[wiki/c4/deployment]]

## References

- [[raw/2026-08-13-secure-bridge-deployment-verification]]
- [[repos/jormungand/lib/store.ts]]
- [[repos/jormungand/lib/workspace.ts]]
