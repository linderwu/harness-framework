---
title: Repository Layer
type: repository-layer
created: 2026-08-11
updated: 2026-08-12
---

# Repository Layer

Ouroboros expects production code to live under `repos/<repo-name>/`.

Jormungand now keeps the Next.js application project under:

```text
repos/jormungand/
```

The application project contains:

- `.harness/`
- `app/`
- `components/`
- `data/`
- `lib/`
- `public/`
- `scripts/`
- `tests/`
- `package.json`
- `tsconfig.json`
- `next.config.mjs`

## Current Code Source Of Truth

- Application root: `repos/jormungand/`
- Primary application: `repos/jormungand/app/`
- Primary domain/runtime logic: `repos/jormungand/lib/`
- Primary dashboard UI: `repos/jormungand/components/`
- Tests: `repos/jormungand/tests/`

## Workspace Root

The repository root remains the Ouroboros workspace root for:

- `raw/`
- `wiki/`
- `spec/`
- `graphify/`
- `graphify-out/`

Run application commands from `repos/jormungand/`.

Run C4 diagram generation from `repos/jormungand/`; generated architecture
artifacts are written back to the workspace root under `wiki/c4/diagrams/`.
