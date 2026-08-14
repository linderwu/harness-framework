# Task Breakdown

## Implementation Tasks
1. Persist run configuration.
   - Store project, repository, requirement, selected default executor, full per-skill executor assignment map, and plan/design/verification approval policies on create.
   - Verification: AC1 with API create-run check and typecheck.

2. Enforce PlanApproval.
   - Intake-to-plan advancement creates a plan artifact and pending PlanApproval gate.
   - Pending PlanApproval prevents design advancement.
   - Approved PlanApproval allows design; rejected fails; changes requested stays in planning.
   - Verification: AC2 and AC3 with workflow unit tests and API advance/decision checks.

3. Enforce DesignApproval and VerificationApproval.
   - Design output opens DesignApproval before implementation.
   - Verification output opens VerificationApproval before closeout.
   - Gate decisions persist status, actor, timestamp, independence requirement, decider, and decision note.
   - Verification: AC4 with workflow unit tests and API gate-decision checks.

4. Resolve event executors per skill.
   - Generate workflow events and agent runs with `skillAssignments[skill.id]` and fallback to `selectedAgent` only for missing assignments.
   - Verification: AC5 with workflow unit tests covering default and overridden executors.

5. Expose dashboard controls and run state.
   - Display current stage, event skill chain, assigned executor per skill, artifacts, agent runs, approval policies, and pending gate actions.
   - Verification: AC6 with UI/manual or browser check and any available component-level checks.

6. Preserve adapter boundary.
   - Keep Codex/OpenClaw/manual behind the existing agent invocation abstraction.
   - Decide whether OpenClaw is simulated or real before implementation begins.
   - Verification: AC5 and AC7 through executor-resolution tests plus bridge/manual behavior checks.

7. Build verification matrix.
   - Document or implement checks mapping each acceptance criterion to unit/typecheck, API, and UI/manual/browser verification.
   - Verification: AC7 with a verification report that lists the check for every acceptance criterion.

## Verification Matrix
| Acceptance Criterion | Required Checks |
| --- | --- |
| AC1: Run creation persists project, repository, requirement, default agent, per-skill assignments, and plan/design/verification approval policies. | API create-run check; workflow unit test for persisted shape; `npm run typecheck`. |
| AC2: Intake creates plan artifact and pending PlanApproval; design cannot start while pending. | Workflow unit test for pending gate block; API advance check. |
| AC3: PlanApproval decisions control design transition, rejection, and changes-requested behavior. | Workflow unit tests for approve/reject/changes-requested; API gate-decision check. |
| AC4: DesignApproval and VerificationApproval record required gate fields. | Workflow unit tests for persisted gate metadata; API decision check. |
| AC5: Agent run records use assigned skill executor. | Workflow unit tests for per-skill override and fallback; bridge/manual smoke check if adapter behavior changes. |
| AC6: Dashboard displays stage, skill chain, executors, artifacts, agent runs, and pending gate actions. | Browser/manual UI check; screenshot or DOM check where available. |
| AC7: Verification maps each acceptance criterion to at least one check. | Verification report review; `npm run typecheck`; API and UI/manual checklist evidence. |

## Implementation Gate Notes
- Do not begin implementation until DesignApproval is approved.
- If OpenClaw must be real for MVP, add an adapter task before task 6.
- If decision notes become mandatory, add validation and API/UI tests before task 3 is complete.
