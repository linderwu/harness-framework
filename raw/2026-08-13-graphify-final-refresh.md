---
title: Graphify Final Code Refresh After Ouroboros Documentation Work
type: raw
tags: [graphify, semantic-graph, ouroboros, c4]
source: local-command-output
ingested-by: codex
trust: verified
sanitized: yes
created: 2026-08-13
updated: 2026-08-13
---

# Graphify Final Code Refresh After Ouroboros Documentation Work

> This file lives in the Evidence Layer (`raw/`). It is immutable and append-only.
> Do not rewrite, overwrite, or delete. To supersede it, create a new dated evidence file.

## Context

The deep semantic extraction in
[[raw/2026-08-13-graphify-deep-minimax-run]] completed before the C4 generator
and Ouroboros alignment test were updated. Ouroboros requires another code graph
refresh after those source changes.

## Command Result

Graphify 0.8.41 performed an incremental AST refresh on
`repos/jormungand/`, preserving the semantic graph, followed by a cluster-only
report regeneration.

- Nodes: 500.
- Edges: 985.
- Extracted edges: 937.
- Inferred edges: 48.
- Communities: 31.
- Import cycles: none reported.

The generated graph reflects the final working-tree code used for the
Ouroboros documentation commit. Graphify records the pre-commit `HEAD` in its
freshness metadata because generated graph files are committed after extraction.

## Outputs

- `graphify/jormungand-root/graph.json`
- `graphify/jormungand-root/graph.html`
- `graphify/jormungand-root/GRAPH_REPORT.md`
- `graphify-out/` mirror for the single-repository workspace

## References

- [[raw/2026-08-13-graphify-deep-minimax-run]]
- [[wiki/c4/container]]
