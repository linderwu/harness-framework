---
title: Graphify Deep Extraction with MiniMax
type: raw
tags: [graphify, semantic-graph, minimax, ouroboros]
source: local-command-output
ingested-by: codex
trust: verified
sanitized: yes
created: 2026-08-13
updated: 2026-08-13
---

# Graphify Deep Extraction with MiniMax

> This file lives in the Evidence Layer (`raw/`). It is immutable and append-only.
> Do not rewrite, overwrite, or delete. To supersede it, create a new dated evidence file.

## Tooling

- Graphify package: `graphifyy==0.8.41`.
- PyPI wheel SHA-256 recorded before installation:
  `ac2134b89a801e1a8bdf8f9b2bf2ac273c60e8cb8745f5818e6b22098002ebe3`.
- Backend protocol: OpenAI-compatible.
- Provider: MiniMax Token Plan.
- Endpoint and model followed the MiniMax documentation for
  `https://api.minimax.io/v1` and `MiniMax-M2.7`.
- The API credential existed only in the extraction process environment.

## Extraction

Graphify scanned `repos/jormungand/` from commit `52a020e0`:

- 48 code files.
- 1 documentation file.
- 2 images.
- 499 graph nodes.
- 984 graph edges.
- 30 communities.
- 935 extracted edges.
- 49 inferred edges, with average confidence 0.79.
- Semantic request usage: 964 input tokens and 2,812 output tokens.

The output was scanned for the complete supplied credential before promotion;
no credential material was found.

## Known Limitation

The semantic graph completed successfully. The optional community-label pass
could not parse the provider response and therefore retained deterministic
`Community N` labels. Nodes, relationships, inference confidence, HTML graph,
and report generation were unaffected.

## Outputs

- `graphify/jormungand-root/graph.json`
- `graphify/jormungand-root/graph.html`
- `graphify/jormungand-root/GRAPH_REPORT.md`
- `graphify-out/` mirror for the single-repository workspace

## References

- [[raw/2026-08-13-size-assessment]]
- [[wiki/patterns/graphify-code-only-fallback]]
- [[wiki/c4/container]]
