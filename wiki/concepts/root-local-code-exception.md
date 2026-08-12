---
title: Root-Local Code Exception
type: concept
tags: [ouroboros, repository-layout, migration]
status: superseded
created: 2026-08-11
updated: 2026-08-12
---

# Root-Local Code Exception

## Summary

This exception has been superseded. Jormungand originally applied the Ouroboros
knowledge layers without moving the existing Next.js source tree into
`repos/jormungand/`, but the application project now lives under
`repos/jormungand/`.

## Context

Ouroboros v2.8 says production code belongs in `repos/<repo-name>/`; see
[[raw/2026-08-11-ouroboros-skill-source]]. The first migration kept the working
Next.js layout at the root to avoid breaking runtime paths.

## Decision

Move the full application project into `repos/jormungand/` and treat that
directory as the app root for build, test, dev, and runtime bridge commands.
Keep `raw/`, `wiki/`, `spec/`, and graph evidence at the workspace root.

## Alternatives Considered

- Keep root-local source permanently: rejected because it violates the canonical
  Ouroboros repository layer after the migration can be done safely.
- Only add docs without graph/spec/wiki layers: rejected because the user
  requested applying the Ouroboros architecture, not only documenting it.

## Consequences

- Wiki pages should cite code under `repos/jormungand/...`.
- Application commands should run from `repos/jormungand/`.
- Existing graph evidence under `graphify/jormungand-root/` remains historical
  until regenerated for `repos/jormungand/`.

## Validation

The initial code graph was generated from the root-local source tree and
recorded in [[raw/2026-08-11-graphify-code-only-run]]. The migration is covered
by `repos/jormungand/tests/ouroboros-layout.test.ts`.

## Invalidation Triggers

- New root-local production source directories reappear.
- Application commands stop working from `repos/jormungand/`.

## References

- [[raw/2026-08-11-user-request-ouroboros-application]]
- [[raw/2026-08-11-ouroboros-skill-source]]
- `repos/README.md`
