---
title: Ouroboros Wiki Schema
type: schema
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Ouroboros Wiki Schema

Curated wiki content is durable knowledge. It should explain why the system is shaped a certain way, where important entities live, and what future agents should check before changing behavior.

## Required Frontmatter

```yaml
---
title: <string>
type: entity | concept | pattern | comparison | c4
tags: [<string>]
status: active | superseded | deprecated
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

## Wikilinks

```text
Evidence: [[raw/YYYY-MM-DD-source-type]]
Code source: [[repos/<repo-name>/path/to/file]]
Entities: [[wiki/entities/<entity-name>]]
Concepts: [[wiki/concepts/<concept-name>]]
Patterns: [[wiki/patterns/<pattern-name>]]
Comparisons: [[wiki/comparisons/<comparison-name>]]
```

Root-local code exception pages should cite concrete root paths and link [[wiki/concepts/root-local-code-exception]].

## Layer Rules

- `raw/` is append-only evidence.
- `wiki/` is curated interpretation and decision memory.
- `spec/` is the construction contract.
- `graphify/` and `graphify-out/` are generated relationship evidence.
- `wiki/c4/workspace.dsl` is the canonical architecture model.

## Review Rules

Substantive wiki/spec changes should be reviewed before merging. Concept pages are not deleted; mark obsolete pages as `superseded` and link the replacement.
