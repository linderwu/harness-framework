---
title: Graphify Code-Only Extraction Run
type: raw
source: log-snapshot
source_url: local-command-output
ingested_by: codex
trust: verified
sanitized: yes
date: 2026-08-11
created: 2026-08-11
updated: 2026-08-11
---

# Graphify Code-Only Extraction Run

> This file lives in the Evidence Layer (`raw/`). It is immutable and append-only.
> Do not rewrite, overwrite, or delete. To supersede it, create a new dated evidence file.

## Source

Local `graphify` command output on 2026-08-11.

## Trust and Sanitization

- trust: verified, because this records local tool output from the target repository.
- sanitized: yes, because no secrets or user data were included.

## Date

2026-08-11

## Content

`graphify --version` returned `graphify 0.8.41`.

`graphify . --output-dir graphify/jormungand-root --mode deep` failed because semantic extraction for docs/images required an LLM API key.

`graphify update . --force` succeeded as the code-only fallback:

- 609 nodes
- 1054 edges
- 40 communities
- output written to `graphify-out/`
- output copied to `graphify/jormungand-root/`

## Tags

- domain: engineering
- type: graphify-run

## Referenced By

- [[wiki/patterns/graphify-code-only-fallback]]
- [[wiki/c4/container]]
