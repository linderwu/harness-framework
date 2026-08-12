---
title: Technical Debt - Synchronous Bridge Transport
type: concept
tags: [technical-debt, bridge, reliability, async]
status: active
created: 2026-08-13
updated: 2026-08-13
---

# Technical Debt - Synchronous Bridge Transport

## Summary

Agent bridge requests currently wait for the executor to finish before the
application persists the terminal result. This keeps the transport simple, but
long agent runs can outlive an HTTP proxy request and become difficult to
reconcile safely.

## Context

- Goal: restore trustworthy Codex and OpenClaw workflow execution without a
  broad queueing redesign.
- Constraint: the existing workflow API and bridges use synchronous
  `POST /agent-runs` responses.
- Evidence: [[raw/2026-08-13-secure-bridge-deployment-verification]].

## Decision

Keep the synchronous transport for the verified deployment and explicitly avoid
claiming that active-run polling is a durable asynchronous execution contract.

## Debt Accepted

- A platform timeout can hide a still-running local executor.
- Retrying after an ambiguous timeout can duplicate work.
- Stop/cancel and terminal-result reconciliation are weaker than a durable job
  protocol.

## Alternatives Considered

- Immediate async `202` dispatch plus polling: stronger reliability, but a
  larger protocol and persistence change than required for this deployment.
- External queue now: durable, but introduces another production subsystem.

## Repayment Trigger

Repay this debt before enabling long-running unattended stages, automatic
retries, multiple application replicas, or an availability SLO that exceeds the
HTTP proxy timeout envelope.

## Consequences

Smoke tests should remain short, and operators must treat an HTTP timeout as
ambiguous rather than proof that the executor stopped.

## Owner Or Review Surface

- [[wiki/entities/agent-bridge]]
- [[wiki/entities/workflow-engine]]
- [[spec/agent-bridge/SPEC]]

## References

- [[raw/2026-08-13-secure-bridge-deployment-verification]]
- [[repos/jormungand/lib/agent-bridge.ts]]
- [[repos/jormungand/scripts/codex-bridge.mjs]]
- [[repos/jormungand/scripts/openclaw-bridge.mjs]]
