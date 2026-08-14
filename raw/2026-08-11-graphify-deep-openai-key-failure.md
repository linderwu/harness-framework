---
title: Graphify Deep Extraction OpenAI Key Failure
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

# Graphify Deep Extraction OpenAI Key Failure

> This file lives in the Evidence Layer (`raw/`). It is immutable and append-only.
> Do not rewrite, overwrite, or delete. To supersede it, create a new dated evidence file.

## Source

Local `graphify` command output on 2026-08-11.

## Trust and Sanitization

- trust: verified, because this records local tool output from the target repository.
- sanitized: yes, because the API key value is intentionally omitted.

## Date

2026-08-11

## Content

The user authorized using a provided key for Graphify. The key was used only as a process environment variable and was not written to repository files.

`graphify . --output-dir graphify/jormungand-root --mode deep --backend openai` failed because the OpenAI backend returned `401 invalid_api_key`.

The valid graph evidence for this migration remains the code-only Graphify run recorded in [[raw/2026-08-11-graphify-code-only-run]].

## Tags

- domain: engineering
- type: graphify-run

## Referenced By

- [[wiki/patterns/graphify-code-only-fallback]]
