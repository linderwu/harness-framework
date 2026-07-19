# Workflow Event Skills

The harness workflow is modeled as a chain of event skills. Each event skill defines one bounded development action, its trigger, allowed actor, inputs, outputs, constraints, gates, knowledge sources, and verification rules.

This makes the workflow stricter than a free-form agent loop:

- Agents receive one bounded event at a time.
- Each event has explicit constraints.
- Artifacts are produced at event boundaries.
- Approval gates are modeled as skills, not informal comments.
- `omx_wiki` can be used as the persistent project knowledge source.

## Event Skill Contract

```ts
interface WorkflowEventSkill {
  id: string
  eventType: WorkflowEventType
  stage: WorkflowStage
  name: string
  purpose: string
  trigger: string
  allowedActors: Array<AgentKind | ApprovalActorType>
  inputs: string[]
  outputs: string[]
  constraints: string[]
  gates: string[]
  knowledgeSources: string[]
  verificationRules: string[]
}
```

Each workflow run also stores per-skill executor assignment:

```ts
interface WorkflowRun {
  schemaVersion: number
  version: number
  selectedAgent: AgentKind
  skillAssignments: Record<string, AgentKind>
  revisions: WorkflowRevision[]
  eventLogStatus: "consistent" | "drift_detected"
}
```

`selectedAgent` is only the default. The actual executor for a skill is resolved from `skillAssignments[skill.id]`.

## Runtime Event Contract

```ts
interface WorkflowEvent {
  id: string
  workflowRunId: string
  skillId: string
  eventType: WorkflowEventType
  stage: WorkflowStage
  status: "pending" | "running" | "waiting_for_gate" | "completed" | "failed"
  actor: string
  inputArtifactIds: string[]
  outputArtifactIds: string[]
  constraintsSnapshot: string[]
  note?: string
  createdAt: string
  completedAt?: string
}
```

## Default Skill Chain

1. `intake.requirement`
   - Captures raw requirements.
   - Cannot design or implement.
   - Writes the requirement artifact.

2. `plan.interview`
   - Clarifies scope, risks, acceptance criteria, and non-goals.
   - Uses `standard-dev-workflow`, `omx_wiki`, and GitHub issue context.
   - Writes the plan artifact.

3. `plan.review`
   - Reviews the plan for missing scope, weak acceptance criteria, and blockers.
   - Defaults to Codex so planning is not approved without a separate review pass.
   - Blocking findings return the run to planning.

4. `plan.approval`
   - Stops the workflow until the plan is approved.
   - A rejected plan cannot move into design.

5. `design.openspec`
   - Converts the approved plan into an OpenSpec-style design artifact.
   - Cannot directly change product code.

6. `design.approval`
   - Reviews the design before implementation.
   - May be handled by a human, verification subagent, or independent agent.
   - Prefer independent review when the implementation agent drafted the design.

7. `implementation.dispatch`
   - Sends the approved design to the selected development agent.
   - Restricts edits to the approved task scope.

8. `implementation.code_review`
   - Reviews implementation output for bugs, regressions, security risks, and missing tests.
   - Defaults to Codex.
   - HIGH or CRITICAL findings return the run to implementation before runtime verification.

9. `verification.implementation_review`
   - Exercises key user scenarios end to end.
   - Stores implementation review reports and may store scenario logs, screenshots, and findings.
   - Blocking findings return the run to implementation.

10. `verification.generate`
   - Generates verification artifacts and maps checks to acceptance criteria.
   - Tests requirements, not merely the current implementation.

11. `verification.approval`
   - Gates final readiness.
   - May be handled by a human, verification subagent, or independent agent.
   - Failed verification returns to implementation.

12. `closeout.archive`
   - Finalizes the run.
   - Keeps artifacts available for future wiki capture.

## Knowledge Source Policy

`omx_wiki` is treated as the local project knowledge base. Event skills should use it for:

- Architecture decisions.
- Project conventions.
- Testing patterns.
- Prior debugging lessons.
- Session logs.
- Accepted tradeoffs.

The workflow engine should not assume vector search. Keyword and tag-based wiki lookup is enough for the first version.

## Constraint Policy

Each event skill owns its constraint list. The runner should pass the constraints into the selected agent prompt and persist them as `constraintsSnapshot` on the event. This makes later review possible even if the skill definition changes.

## Executor Assignment Policy

Every event skill must be assigned an executor agent before the run starts.

Supported MVP executors:

- `codex`
- `openclaw.rowlet`
- `openclaw.roaringmoon`
- `openclaw.charizard`
- `manual`

The dashboard lets the user set a default development agent, then override the executor for each individual skill. Runtime events and agent run records must use the assigned executor, not the workflow-level default.

Approval policy is separate from executor assignment. For example, `design.approval` may be executed by `codex`, while the approval policy requires an independent reviewer decision.

## Approval Policy

Approval gates are skills because review is work, not a boolean flag.

Design and verification approval may be assigned to:

- `human`
- `verification_subagent`
- `independent_agent`

High-risk work should require `independent_agent` or human approval.

## Review Findings Policy

Plan review, code review, and implementation review reports must include
severity labels and an explicit `Blocking findings: yes|no` line. HIGH and
CRITICAL findings are blocking. A blocking review creates a revision request and
routes the workflow back to the stage that can fix the issue:

- Plan review findings return to `plan`.
- Code review findings return to `implementation`.
- Implementation review findings return to `implementation`.

The next agent run receives prior artifacts, including the review report, so the
fix loop has the same context a human reviewer would hand back.

## Concurrency Policy

Every stored workflow run carries a monotonically increasing `version`. Mutating
API routes read a run, derive the next state, and write it back with
`expectedVersion`. If another stop, cancel, approval, or advance writes first,
the store rejects the stale write with HTTP 409 and returns the latest run.

The JSON file store is still an MVP persistence layer, but writes are centralized
and serialized inside the process. A database-backed store should keep the same
compare-and-set contract.

## Revision Cycle Policy

`changes_requested` is not a terminal dead end. A gate decision creates a
`WorkflowRevision` and moves the run back to its target stage:

- Plan gate revisions return to `plan`.
- Design gate revisions return to `design`.
- Verification gate revisions return to `implementation`.

The next advance resubmits work, links artifacts/events/gates to the revision,
and opens a fresh approval gate. Approval accepts the revision; rejection marks
it rejected and fails the run.

## Event Log Integrity Policy

`events[]` remains an audit log, not full event sourcing. The run records
`eventLogStatus` so readers can distinguish a consistent audit trail from a
state/event mismatch, such as an event output reference pointing at a missing
artifact. Future event sourcing work should add replay/rebuild before treating
events as the source of truth.
