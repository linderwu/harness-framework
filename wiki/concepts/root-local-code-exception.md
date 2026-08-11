---
title: Root-Local Code Exception
type: concept
tags: [ouroboros, repository-layout, migration]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Root-Local Code Exception

## Summary

Jormungand applies the Ouroboros knowledge layers without moving the existing Next.js source tree into `repos/jormungand/` during the first migration.

## Context

Ouroboros v2.8 says production code belongs in `repos/<repo-name>/`; see [[raw/2026-08-11-ouroboros-skill-source]]. This repository already has a working Next.js layout at the root, with `app/`, `components/`, `lib/`, `scripts/`, and `tests/`.

## Decision

Keep production code at the repository root for now. Use `repos/README.md` to document the exception and treat root paths as the current code source of truth until a dedicated move can be done safely.

## Alternatives Considered

- Move all code into `repos/jormungand/`: rejected for this pass because it would require coordinated build, TypeScript, Next.js, test, script, and deployment updates.
- Only add docs without graph/spec/wiki layers: rejected because the user requested applying the Ouroboros architecture, not only documenting it.

## Consequences

- Wiki pages cite root-local code paths for now instead of canonical `repos/<repo-name>/...` paths.
- The graph bridge is stored under `graphify/jormungand-root/`.
- A future migration can normalize the repository layer when runtime paths are updated together.

## Validation

The initial code graph was generated from the root-local source tree and recorded in [[raw/2026-08-11-graphify-code-only-run]].

## Invalidation Triggers

- Build/deploy tooling is ready to support `repos/jormungand/`.
- The workspace becomes multi-repo.
- Root-local paths cause repeated agent or graphify confusion.

## References

- [[raw/2026-08-11-user-request-ouroboros-application]]
- [[raw/2026-08-11-ouroboros-skill-source]]
- `repos/README.md`
