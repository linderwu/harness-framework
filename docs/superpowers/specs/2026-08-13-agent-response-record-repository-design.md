# Agent Response Record Repository Design

## Goal

Publish every completed Agent Task response into one GitHub record repository named `jormungand-record`.

The dashboard keeps using its local JSON-backed workflow state for operational behavior. The GitHub repository is a durable archive for completed agent responses, audit history, and long-term search.

## Chosen Approach

Automatically publish the completed `agent_task.response` artifact after the task response is generated.

The local workflow remains the source of truth for dashboard state:

- `data/harness-state.json` stores projects, workflow runs, events, and artifacts.
- `WorkflowRun.artifacts[]` keeps the Agent Response artifact body.
- The GitHub record repository stores a Markdown copy of completed Agent Task responses.

Publishing to GitHub is best-effort. A GitHub failure should not erase the local response or mark the whole Agent Task as failed after the agent already returned a response. Instead, the run records the publish failure so the user can inspect or retry it later.

## Repository

Use the GitHub-friendly repository slug `jormungand-record`.

The display name can still be described as `jormungand record`, but code and URLs should use the hyphenated slug.

The existing GitHub repository helper should be reused where possible:

- It already accepts repository names, `owner/name`, and GitHub URLs.
- It already supports `GITHUB_TOKEN`, `GH_TOKEN`, and GitHub CLI fallback.
- It already creates missing repositories and seeds `AGENTS.md`.

The record repository should default to the current authenticated GitHub account unless an explicit owner is configured.

## Record Format

Each completed Agent Task writes one Markdown file:

```text
records/YYYY/MM/DD/<workflowRunId>.md
```

The date folders use the workflow run completion or update timestamp in UTC ISO date form.

Each record includes:

- Title: `Agent Task Response`
- Project name
- Workflow run id
- Project id
- Selected agent
- Source
- Repository target from the original task, when present
- Status
- Created and updated timestamps
- Original instruction
- Raw agent response
- Closeout status

The Markdown body should be deterministic so re-publishing the same workflow run updates the same file path instead of creating duplicates.

## Data Flow

1. The dashboard starts an Agent Task through the existing workflow run API.
2. `advanceAgentTask` invokes the configured agent.
3. The returned response is wrapped into the existing mixed response artifact:
   - `Original Instruction`
   - `Raw Agent Response`
   - `Agent Response`
   - `Closeout Status`
4. After the artifact exists, the system publishes a Markdown copy to `jormungand-record`.
5. The local workflow run is persisted through `upsertWorkflowRun`.

The publish step should be attached close to the Agent Task completion path, not to dashboard rendering. Rendering should never be responsible for external side effects.

## Configuration

Default configuration:

- Record repository: `jormungand-record`
- Visibility: same behavior as existing repository creation, controlled by `GITHUB_REPOSITORY_VISIBILITY`

Optional future configuration:

- `JORMUNGAND_RECORD_REPOSITORY`: override the repository target with `owner/name`, a repo name, or a GitHub URL.
- `JORMUNGAND_RECORD_BRANCH`: publish to a non-default branch.

The first implementation can publish to the repository default branch only.

## Error Handling

Publishing errors should be visible but non-destructive.

If GitHub authentication is missing, invalid, rate-limited, or unavailable:

- Keep the local Agent Response artifact.
- Keep the workflow completion state when the agent response itself completed.
- Attach a short publish failure note to the workflow run.

If the same record path already exists:

- Update the existing file when the content changed.
- Avoid a new commit when the content is identical.

If repository creation fails:

- Treat it like any other publish failure.
- Do not retry in a tight loop.

## Component Boundaries

Add a focused record publishing module rather than expanding workflow storage logic.

Proposed module:

- `lib/agent-response-records.ts`

Responsibilities:

- Locate the Agent Response artifact for an Agent Task run.
- Format a deterministic Markdown record.
- Resolve the target repository.
- Create or update the GitHub file.
- Return a publish result that can be stored on the workflow run.

Existing modules remain responsible for their current boundaries:

- `lib/workflow.ts`: creates and completes workflow artifacts.
- `lib/store.ts`: reads and writes local JSON state.
- `lib/github-repository.ts`: ensures GitHub repositories exist.

## Testing

Add focused tests that assert:

- Agent Task completion still stores the response locally.
- A completed Agent Task produces the expected record path.
- The Markdown formatter includes instruction, raw response, agent, status, and timestamps.
- GitHub publish failure does not remove the local artifact or fail an otherwise completed Agent Task.
- Re-publishing the same run uses the same path.

Run:

```powershell
npm run typecheck
npm run lint
npm run test
```

## Open Decisions

None. The user selected automatic publishing to a unified GitHub record repository.
