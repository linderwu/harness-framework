---
title: Production C4 Diagram Generation Verification
type: raw
tags: [c4, diagrams, deployment, ouroboros]
source: local-command-and-render-output
ingested-by: codex
trust: verified
sanitized: yes
created: 2026-08-13
updated: 2026-08-13
---

# Production C4 Diagram Generation Verification

> This file lives in the Evidence Layer (`raw/`). It is immutable and append-only.
> Do not rewrite, overwrite, or delete. To supersede it, create a new dated evidence file.

## Canonical Model

`wiki/c4/workspace.dsl` now contains separate `deploymentLocal` and
`deploymentProduction` views. The production model records Zeabur site auth and
liveness, authenticated Codex/OpenClaw v0.3 bridges, the Cloudflare-to-VM
tunnel, the VM user service on port 4178, the OpenClaw Docker runtime, pinned SSH
deployment, and the deployed runtime-skill lockfile.

## Generation Result

`npm run c4:diagrams` generated:

- 12 C4 views.
- 12 Mermaid files.
- 12 SVG files.
- 1 HTML index.
- 1 manifest with no missing or empty outputs.

The production, API component, workflow dynamic, and container SVGs were
rendered to raster previews and visually inspected. Production and API layouts
were adjusted to remove overlapping edges and labels. Every SVG parsed as valid
XML and includes an explicit white canvas for readable previews.

## Drift Protection

`repos/jormungand/tests/ouroboros-layout.test.ts` now verifies that the canonical
DSL, explanatory deployment Wiki, hard-coded diagram generator, and manifest
all retain the production view and its critical boundary terms.

## Validation

- Project tests: 56 passed, 0 failed.
- Typecheck: passed.
- Lint: passed.
- Production build: passed.
- Dependency audit: 0 vulnerabilities.
- Wikilink integrity: passed.
- Wiki staleness strict scan: passed.
- Sensitive-value pattern scan: no matches.

## Outputs

- `wiki/c4/diagrams/deployment-production.mmd`
- `wiki/c4/diagrams/deployment-production.svg`
- `wiki/c4/diagrams/component-api-routes.mmd`
- `wiki/c4/diagrams/component-api-routes.svg`
- `wiki/c4/diagrams/dynamic-start-workflow-run.mmd`
- `wiki/c4/diagrams/dynamic-start-workflow-run.svg`
- `wiki/c4/diagrams/index.html`
- `wiki/c4/diagrams/manifest.json`

## References

- [[raw/2026-08-13-secure-bridge-deployment-verification]]
- [[wiki/c4/deployment]]
- [[wiki/c4/component]]
- [[wiki/c4/dynamic]]
