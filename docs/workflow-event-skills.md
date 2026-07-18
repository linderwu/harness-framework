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
  selectedAgent: AgentKind
  skillAssignments: Record<string, AgentKind>
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

3. `plan.approval`
   - Stops the workflow until the plan is approved.
   - A rejected plan cannot move into design.

4. `design.openspec`
   - Converts the approved plan into an OpenSpec-style design artifact.
   - Cannot directly change product code.

5. `design.approval`
   - Reviews the design before implementation.
   - May be handled by a human, verification subagent, or independent agent.
   - Prefer independent review when the implementation agent drafted the design.

6. `implementation.dispatch`
   - Sends the approved design to the selected development agent.
   - Restricts edits to the approved task scope.

7. `verification.generate`
   - Generates verification artifacts and maps checks to acceptance criteria.
   - Tests requirements, not merely the current implementation.

8. `verification.approval`
   - Gates final readiness.
   - May be handled by a human, verification subagent, or independent agent.
   - Failed verification returns to implementation.

9. `closeout.archive`
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
