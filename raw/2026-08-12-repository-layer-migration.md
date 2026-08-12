---
title: Repository Layer Migration Verification
type: evidence
created: 2026-08-12
---

# Repository Layer Migration Verification

## Context

The Next.js application project was moved from the workspace root into
`repos/jormungand/` so the repository follows the Ouroboros repository-layer
rule.

## Application Root

```text
repos/jormungand/
```

## Validation

The migration adds `repos/jormungand/tests/ouroboros-layout.test.ts`, which
fails when run from the old workspace root and passes only when the app project
is rooted under `repos/jormungand/`.

## Command Shape

```text
cd repos/jormungand
npm.cmd test
npm.cmd run c4:diagrams
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```
