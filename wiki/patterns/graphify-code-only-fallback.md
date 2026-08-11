---
title: Graphify Code-Only Fallback
type: pattern
tags: [graphify, tooling, fallback]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Graphify Code-Only Fallback

## Summary

When Graphify deep semantic extraction lacks an LLM API key, use `graphify update . --force` to refresh the code graph without semantic document/image extraction.

## Context

The first Ouroboros migration attempted deep extraction and Graphify reported that doc/paper/image semantic extraction required an API key. The code-only command succeeded and produced 609 nodes, 1054 edges, and 40 communities; see [[raw/2026-08-11-graphify-code-only-run]].

A later deep extraction attempt with a user-provided OpenAI backend key failed with `401 invalid_api_key`; see [[raw/2026-08-11-graphify-deep-openai-key-failure]]. Keep the code-only graph as the current valid graph evidence until a working backend key is available.

## Procedure

```powershell
graphify update . --force
Copy-Item graphify-out\graph.json graphify\jormungand-root\graph.json -Force
Copy-Item graphify-out\graph.html graphify\jormungand-root\graph.html -Force
Copy-Item graphify-out\GRAPH_REPORT.md graphify\jormungand-root\GRAPH_REPORT.md -Force
```

## Use When

- Code changed and relationship evidence needs refresh.
- No LLM API key is available.
- Document/image semantic extraction is not required for the delivery claim.

## Limits

This fallback does not semantically ingest docs, papers, or images. Use deep extraction with an approved API key when those artifacts are material evidence.

## References

- [[raw/2026-08-11-graphify-code-only-run]]
- [[raw/2026-08-11-graphify-deep-openai-key-failure]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
