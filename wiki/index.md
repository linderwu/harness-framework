---
title: Jormungand Ouroboros Index
type: index
status: active
created: 2026-08-11
updated: 2026-08-21
---

# Jormungand Ouroboros Index

This workspace follows the Ouroboros Trivium knowledge architecture from [[raw/2026-08-11-ouroboros-skill-source]].

## Layers

- Evidence: `raw/`
- Code repository layer: `repos/`
- Relationship graph: `graphify/jormungand-root/` and `graphify-out/`
- Curated wiki: `wiki/`
- Construction contracts: `spec/`

## Current Architecture

- System spec: [[spec/SPEC]] — now covers the A2A v0.3 public
  surface, hive memory operations, the manager scheduler, the
  minimax bridge, the agent permission mode, and the Superpowers
  catalog.
- C4 model: [[wiki/c4/workspace]]
- System context: [[wiki/c4/system-context]]
- Container view: [[wiki/c4/container]]
- Component views: [[wiki/c4/component]]
- Dynamic view: [[wiki/c4/dynamic]]
- Deployment view: [[wiki/c4/deployment]]
- Code-level reference view: [[wiki/c4/code]]
- Generated diagrams: `wiki/c4/diagrams/index.html`
- Production deployment evidence: [[raw/2026-08-13-secure-bridge-deployment-verification]]
- Production diagram evidence: [[raw/2026-08-13-c4-production-diagram-generation]]

## Entities

- [[wiki/entities/harness-dashboard]] — browser-facing Next.js
  dashboard. Includes the conversation panel and the
  `agent-live` SSE feed.
- [[wiki/entities/workflow-engine]] — stage state machine and
  approval gates. Delegates managed runs to the
  [[wiki/entities/agent-bridge]] and the manager scheduler
  (see [[spec/SPEC]]).
- [[wiki/entities/agent-bridge]] — dispatch chokepoint for
  Codex, OpenClaw, and minimax executors. Honors the agent
  permission mode.
- [[wiki/entities/workspace-store]] — JSON-backed projects and
  workflow runs. Persists next to hive memory and shares the
  data-directory backup contract (see [[spec/SPEC]]).

> **Note:** Several major subsystems do not yet have dedicated
> entity pages: the A2A server, hive memory, manager scheduler,
> execution-job queue, runtime-skill resolver, and Superpowers
> catalog. They are documented inside [[spec/SPEC]] as of the
> 2026-08-21 refresh and are awaiting dedicated curation in a
> follow-up cycle; see [[raw/2026-08-21-wiki-spec-refresh]].

## Concepts

- [[wiki/concepts/root-local-code-exception]]
- [[wiki/concepts/tech-debt-json-state-persistence]]
- [[wiki/concepts/tech-debt-synchronous-bridge-transport]]

> **Note:** Additional concepts surfaced by the 2026-08-21
> refresh (the agent permission mode, the per-IP lockout, the
> A2A redaction rules, and the idempotency-key pattern) are
> described inside [[spec/SPEC]] and the `repos/jormungand/`
> source today, and await dedicated concept pages in a
> follow-up cycle; see [[raw/2026-08-21-wiki-spec-refresh]].

## Patterns

- [[wiki/patterns/graphify-code-only-fallback]]

> **Note:** Additional reusable patterns surfaced by the
> 2026-08-21 refresh (optimistic concurrency, A2A redaction, the
> OpenClaw live-event relay) are described inside [[spec/SPEC]]
> and the `repos/jormungand/` source today, and await dedicated
> pattern pages in a follow-up cycle; see
> [[raw/2026-08-21-wiki-spec-refresh]].

## Graph Evidence

- `graphify/jormungand-root/graph.json`
- `graphify/jormungand-root/graph.html`
- `graphify/jormungand-root/GRAPH_REPORT.md`
- Deep Graphify run: [[raw/2026-08-13-graphify-deep-minimax-run]]
- Final graph refresh: [[raw/2026-08-13-graphify-final-refresh]]

> **Note:** The relationship graphs and the C4 diagrams were
> last regenerated on 2026-08-13. They do not yet reflect the
> A2A v0.3 surface, hive memory, or the manager scheduler.
> Regeneration is deferred to a follow-up cycle; see
> [[raw/2026-08-21-wiki-spec-refresh]].
