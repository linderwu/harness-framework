# Change: Add Harness Dashboard Agent and Approval Gate Control

## Summary
Build the Harness MVP dashboard flow so a workflow run can select `codex`, `openclaw`, or `manual` executors, override executors per workflow skill, and control plan, design, and verification progress through explicit approval gates.

## Motivation
The harness architecture models development as an event-driven skill chain with durable artifacts and approval gates. The dashboard needs to expose that model directly so users can configure execution, inspect artifacts, and decide gates before later stages run.

## Scope
- Persist project, repository, requirement, default executor, per-skill executor assignments, and plan/design/verification approval policies when a workflow run is created.
- Resolve every event executor from `skillAssignments[skill.id]`, falling back to the workflow default only when an assignment is missing.
- Require PlanApproval before OpenSpec design, DesignApproval before implementation dispatch, and VerificationApproval before completion.
- Record gate status, actor policy, assigned agent, independence requirement, timestamp, decider, and decision note.
- Display current stage, event skill chain, executor assignment, artifacts, agent runs, and pending gate actions in the dashboard.
- Map each acceptance criterion to unit/typecheck, API, and UI/manual verification.

## Out of Scope
- Product implementation for this design event.
- A full real OpenClaw runner if MVP scope confirms OpenClaw remains simulated.
- Branch creation, PR creation, CI integration, or GitHub automation.
- Rich concurrency control beyond documented file-backed state risk handling.

## Open Questions
1. Must `openclaw` call a real local or external runner for MVP, or is the simulated adapter acceptable for the first dashboard release?
2. Should non-human approval actors auto-decide design and verification gates in MVP, or should the dashboard always show an explicit pending decision until an agent result is recorded?
3. Are decision notes mandatory for all approval outcomes, or only for rejection and changes-requested decisions?
4. Should manual executors be allowed with verification subagent or independent-agent approval policies, and if so what dashboard copy should warn about the mixed mode?
