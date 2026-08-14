---
title: Ouroboros Skill v2.8 Source
type: raw
source: external-ref
source_url: https://github.com/linderwu/ouroboros
ingested_by: codex
trust: verified
sanitized: yes
date: 2026-08-11
created: 2026-08-11
updated: 2026-08-11
---

# Ouroboros Skill v2.8 Source

> This file lives in the Evidence Layer (`raw/`). It is immutable and append-only.
> Do not rewrite, overwrite, or delete. To supersede it, create a new dated evidence file.

## Source

GitHub repository: <https://github.com/linderwu/ouroboros>

The repository was cloned locally on 2026-08-11 and contained:

- `SKILL.md`
- `README.md`
- `references/`
- `hooks/wikilink-integrity-guard.py`
- `hooks/wiki-staleness-scan.py`

## Trust and Sanitization

- trust: verified, because the content was fetched from the requested GitHub repository.
- sanitized: yes, because it was used as architecture guidance and local hooks/templates only.

## Date

2026-08-11

## Content

The fetched `SKILL.md` identifies the skill as Ouroboros (Trivium v2.8) and defines these core layers:

- `raw/`: append-only evidence.
- `repos/`: actual code repositories.
- `graphify/`: generated relationship graph per repo.
- `graphify-out/`: optional merged cross-repo graph.
- `wiki/`: curated knowledge, including entities, concepts, patterns, comparisons, and C4 views.
- `spec/`: OpenSpec-style construction contracts.

It also requires codebase-MCP-first discovery, technical debt records under `wiki/concepts/`, cognitive debt records under `wiki/c4/`, and `wiki/c4/workspace.dsl` as the canonical C4 model.

## Tags

- domain: engineering
- type: external-reference

## Referenced By

- [[wiki/SCHEMA]]
- [[wiki/concepts/root-local-code-exception]]
- [[spec/SPEC]]
