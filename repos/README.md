---
title: Repository Layer
type: repository-layer
created: 2026-08-11
updated: 2026-08-11
---

# Repository Layer

Ouroboros expects production code to live under `repos/<repo-name>/`.

For this migration, `jormungand` keeps the existing Next.js source tree at the repository root:

- `app/`
- `components/`
- `lib/`
- `scripts/`
- `tests/`

This is an explicit root-local code exception, recorded in [[wiki/concepts/root-local-code-exception]].

## Why Not Move Code Now

Moving the source tree into `repos/jormungand/` would require coordinated updates to Next.js config, TypeScript path aliases, tests, scripts, deployment assumptions, and existing local workflows. The first Ouroboros application should establish traceability without breaking runtime paths.

## Current Code Source of Truth

- Repository root: `./`
- Primary application: `app/`
- Primary domain/runtime logic: `lib/`
- Primary dashboard UI: `components/`
- Tests: `tests/`

## Future Migration Trigger

Move code under `repos/jormungand/` only when the build, test, deployment, and Codex bridge scripts are updated in the same change and the move can be verified end to end.
