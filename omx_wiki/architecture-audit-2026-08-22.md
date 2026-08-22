# Harness Architecture Audit — 2026-08-22

Canonical detailed report: [[wiki/concepts/architecture-risk-register-2026-08-22]]

Scope: `repos/jormungand/` is the runnable application. `elle_amr_src/` is a
separate nested repository and is not part of the Harness control plane.

Key findings:

- Workflow/project state is JSON-backed while Hive memory, conversations, A2A
  audit, manager state, and execution jobs are SQLite-backed. The operations
  and backups are paired operationally but not transactionally.
- Store queues, manager locks, live SSE state, A2A in-flight work, and bridge
  sessions are process-local. Restart and multi-replica behavior is therefore
  not equivalent to durable queue recovery.
- Normal workflow, managed jobs, conversations, and A2A use different
  execution lifecycles; several still wait on long-running bridge work inside
  HTTP requests.
- `lib/workflow.ts` and `lib/hive-memory/repository.ts` are high-centrality
  control-plane modules; stage results are largely normalized from free text.
- Permission mode is ambient configuration, not a persisted run snapshot.
- Typecheck/build pass; lint has 13 warnings; the Windows npm test glob is
  broken; explicit tests report 358 passing and 29 failing.

Use this page as the short prompt-context pointer. Keep the detailed findings
and evidence in the canonical `wiki/` page.
