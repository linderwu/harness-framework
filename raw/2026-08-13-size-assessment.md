---
title: Jormungand Ouroboros Size Assessment
type: raw
tags: [ouroboros, size-assessment, graphify]
source: local-repository-inventory
ingested-by: codex
trust: verified
sanitized: yes
created: 2026-08-13
updated: 2026-08-13
---

# Jormungand Ouroboros Size Assessment

> This file lives in the Evidence Layer (`raw/`). It is immutable and append-only.
> Do not rewrite, overwrite, or delete. To supersede it, create a new dated evidence file.

## Measurement

The `repos/jormungand/` application contained 33 important JavaScript and
TypeScript source files after excluding dependencies, generated directories,
runtime data, and tests.

## Classification

Ouroboros classifies the repository as **L (Large)** because it has more than
20 important source files.

## Tooling Decision

- Preserve deployment and verification evidence under `raw/`.
- Regenerate the full repository Graphify graph after the bridge changes.
- Update module contracts under `spec/`.
- Curate the bridge, deployment, debt, and C4 knowledge under `wiki/`.
- Treat `wiki/c4/workspace.dsl` as the canonical architecture model.

## References

- [[raw/2026-08-11-ouroboros-skill-source]]
- [[raw/2026-08-13-graphify-deep-minimax-run]]
