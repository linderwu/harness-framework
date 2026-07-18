# Harness Event Skill Chain

Tags: harness, workflow, skill-chain, architecture
Category: architecture

The harness framework models development as an event-driven skill chain.

Each workflow run has:

- `eventSkills`: the configured skill chain.
- `skillAssignments`: per-skill executor choices from the dashboard.
- `events`: runtime executions of those skills.
- `artifacts`: durable outputs from event boundaries.
- `approvalGates`: review decisions modeled as workflow gates.

The current default chain is:

1. Requirement Intake
2. Plan Interview
3. Plan Approval
4. OpenSpec Design
5. Design Approval
6. Implementation Dispatch
7. Verification Generation
8. Verification Approval
9. Closeout

Approval is not limited to humans. `DesignApproval` and `VerificationApproval` can be handled by a human, verification subagent, or independent reviewer agent.

Each event skill is executed by a dashboard-selected executor. The workflow-level selected agent is only a default. Per-skill assignments can route planning to Codex, design to OpenClaw, verification generation to an agent path, or any MVP-supported manual/agent combination.

Use this page as the canonical project memory for the event-skill architecture. See [[harness-event-skill-chain]] and `docs/workflow-event-skills.md` when adding new stages or tightening runner constraints.
