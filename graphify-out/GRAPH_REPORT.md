# Graph Report - jormungand  (2026-08-11)

## Corpus Check
- 81 files · ~52,768 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 609 nodes · 1054 edges · 40 communities (32 shown, 8 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 14 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8c91c860`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]

## God Nodes (most connected - your core abstractions)
1. `advanceWorkflow()` - 28 edges
2. `invokeConfiguredAgent()` - 17 edges
3. `WorkflowRun` - 17 edges
4. `getAgentProfile()` - 16 edges
5. `compilerOptions` - 16 edges
6. `Harness Framework Architecture Plan` - 16 edges
7. `Superpowers Runtime Skill Registry Design` - 15 edges
8. `Project Popover Selector Design` - 15 edges
9. `upsertWorkflowRun()` - 14 edges
10. `decideApprovalGate()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `POST()` --calls--> `advanceWorkflow()`  [INFERRED]
  app/api/projects/[id]/workflow-runs/route.ts → lib/workflow.ts
- `POST()` --calls--> `upsertProject()`  [INFERRED]
  app/api/workflow-runs/route.ts → lib/store.ts
- `POST()` --calls--> `advanceWorkflow()`  [INFERRED]
  app/api/workflow-runs/route.ts → lib/workflow.ts
- `POST()` --calls--> `createProject()`  [INFERRED]
  app/api/workflow-runs/route.ts → lib/workspace.ts
- `createRun()` --calls--> `createWorkflowRun()`  [EXTRACTED]
  tests/workflow.test.ts → lib/workflow.ts

## Import Cycles
- None detected.

## Communities (40 total, 8 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (46): BridgeResponse, openClawAgentKinds, AgentRunSource, ApprovalGate, RuntimeSkillBundleResult, actorLabels, addAgentArtifact(), addWorkflowEvent() (+38 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (41): buildProjectOverview(), getProjectTemplate(), projectTemplates, projectTypeOptions, listProjects(), upsertProject(), AgentRun, ApprovalPolicy (+33 more)

### Community 2 - "Community 2"
Cohesion: 0.11
Nodes (36): POST(), POST(), POST(), Home(), POST(), POST(), GET(), cancelConfiguredAgentRun() (+28 more)

### Community 3 - "Community 3"
Cohesion: 0.12
Nodes (41): asRecord(), BridgeLikeResponse, collectArtifactsText(), collectLegacyPayloadText(), collectMessageText(), collectPartsText(), createLegacyClawCodexEnvelope(), createOpenClawA2AEnvelope() (+33 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (39): Agent Adapter Layer, Alternative Considered, API Surface, Architecture, Backend API, Core Principles, Dashboard, Data Model (+31 more)

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (15): AgentHealthResponse, ApprovalDecision, BridgeHealth, BridgeHealthStatus, BridgeId, BridgePanelStatus, BridgeStatusPanel(), defaultEventSkills (+7 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (27): activeAgentRuns, activeIdempotencyKeys, activeWorkflowRuns, asList(), buildPrompt(), downloadFile(), extractTgz(), fileExists() (+19 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (25): dependencies, lucide-react, next, react, react-dom, devDependencies, eslint, eslint-config-next (+17 more)

### Community 8 - "Community 8"
Cohesion: 0.18
Nodes (21): assertValidRepositorySegment(), createOrganizationRepository(), createRepositoryPayload(), createUserRepository(), ensureGitHubRepository(), ensureRepositoryWithApi(), ensureRepositoryWithCli(), fetchGitHubRepository() (+13 more)

### Community 9 - "Community 9"
Cohesion: 0.09
Nodes (21): ApprovalGate, Approved Direction, Artifact, Data Flow, Domain Model, Error Handling, Execution Controls, First-Version Scope (+13 more)

### Community 10 - "Community 10"
Cohesion: 0.15
Nodes (15): ProjectSelector(), buildProjectSelectorItems(), compareActivityDescending(), filterProjectSelectorItems(), formatAbsoluteActivityTime(), formatRelativeActivityTime(), getProjectCompositeStatus(), parseActivityTime() (+7 more)

### Community 11 - "Community 11"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 12 - "Community 12"
Cohesion: 0.12
Nodes (15): Dashboard 使用流程, Git 操作建議, Harness Framework 使用手冊, 前置需求, 啟動 Codex, 啟動 OpenClaw Bridge / A2A, 啟動 OpenClaw Server, 完整本機啟動範例 (+7 more)

### Community 13 - "Community 13"
Cohesion: 0.12
Nodes (15): Agent Attestation, Approved Direction, Audit Policy, Bridge Protocol, Cache Policy, Failure Policy, MVP Scope, Open Decisions (+7 more)

### Community 14 - "Community 14"
Cohesion: 0.12
Nodes (15): Approved Direction, Collapsed State, Component Boundaries, Composite Status, Edge Cases, Filter Semantics, Placement, Popover (+7 more)

### Community 15 - "Community 15"
Cohesion: 0.20
Nodes (13): failure(), matchesRegistryVersion(), resolveRuntimeSkillBundles(), RuntimeSkillLockedBundle, RuntimeSkillLockfile, RuntimeSkillRegistry, RuntimeSkillRegistryBundle, RuntimeSkillRegistryVersion (+5 more)

### Community 16 - "Community 16"
Cohesion: 0.14
Nodes (13): Approval Policy, Concurrency Policy, Constraint Policy, Default Skill Chain, Event Log Integrity Policy, Event Skill Contract, Executor Assignment Policy, Knowledge Source Policy (+5 more)

### Community 17 - "Community 17"
Cohesion: 0.15
Nodes (12): File Structure, Final Verification Checklist, Scope Check, Self-Review, Task 1: Add Project Templates and Domain Types, Task 2: Normalize Workspace State and Legacy Runs, Task 3: Persist Full Workspace State, Task 4: Create Project-Scoped Workflow Runs (+4 more)

### Community 18 - "Community 18"
Cohesion: 0.18
Nodes (10): Bridge Agent Status Cards Design, Chosen Approach, Component Boundaries, Data Flow, Error Handling, Goal, Health Check Behavior, Layout (+2 more)

### Community 19 - "Community 19"
Cohesion: 0.22
Nodes (9): HarnessDashboard(), isCancelableStatus(), isStoppableStatus(), AgentFamily, AgentProfile, getAgentLabel(), getOpenClawMainAgent(), isOpenClawAgent() (+1 more)

### Community 20 - "Community 20"
Cohesion: 0.20
Nodes (9): File Structure, Self-Review Notes, Superpowers Runtime Skill Registry Implementation Plan, Task 1: Runtime Skill Types And Event Declarations, Task 2: Registry And Lockfile Resolver, Task 3: Workflow Runtime Skill Resolution And Audit, Task 4: Bridge v0.3 Descriptor Delivery And Protocol Gate, Task 5: Local Codex Bridge Agent-Local Install (+1 more)

### Community 21 - "Community 21"
Cohesion: 0.20
Nodes (9): File Structure, Project Popover Selector Implementation Plan, Self-Review, Task 1: Add Selector Helper Tests, Task 2: Implement Project Selector Helpers, Task 3: Replace Inline Projects List With ProjectSelector, Task 4: Style the Selector and Popover, Task 5: Add Dashboard Structure Regression Tests (+1 more)

### Community 22 - "Community 22"
Cohesion: 0.20
Nodes (9): Chosen Behavior, Current Behavior, Data Flow, Error Handling, Goal, Layout, Open Decisions, Registered Bridge Cards Placement Design (+1 more)

### Community 23 - "Community 23"
Cohesion: 0.32
Nodes (7): BridgeHealth, BridgeHealthStatus, checkHttpBridge(), createHttpBridgeCheck(), GET(), HttpBridgeCheck, normalizeUrl()

### Community 24 - "Community 24"
Cohesion: 0.25
Nodes (7): Bridge Agent Status Cards Implementation Plan, File Structure, Self-Review, Task 1: Add Bridge Health Endpoint, Task 2: Add Bridge Status Panel Component, Task 3: Style the Bottom-Right Cards, Task 4: Full Verification and Release

### Community 25 - "Community 25"
Cohesion: 0.25
Nodes (7): File Structure, Registered Bridge Cards Placement Implementation Plan, Self-Review, Task 1: Restrict Health Endpoint to Registered HTTP Bridge URLs, Task 2: Move Bridge Cards into the Compose Panel, Task 3: Replace Floating Overlay CSS with In-Panel Styles, Task 4: Full Verification and Merge

### Community 26 - "Community 26"
Cohesion: 0.29
Nodes (6): Local Codex Bridge, Local Development, OpenClaw A2A Command, Ouroboros-Aware Repositories, Verified Zeabur Bridge Parameters, Zeabur To Local Codex

### Community 27 - "Community 27"
Cohesion: 0.60
Nodes (4): config, constantTimeEquals(), hasValidBasicAuth(), proxy()

### Community 28 - "Community 28"
Cohesion: 0.50
Nodes (4): getContextFilePath(), isTextContextFile(), readFileAsBase64(), readProjectContextFile()

### Community 30 - "Community 30"
Cohesion: 0.67
Nodes (3): BridgeStatusCard(), formatBridgeCheckedAt(), getBridgePanelStatus()

## Knowledge Gaps
- **262 isolated node(s):** `BridgeHealthStatus`, `BridgeHealth`, `HttpBridgeCheck`, `metadata`, `orderedStages` (+257 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WorkflowRun` connect `Community 3` to `Community 0`, `Community 1`, `Community 2`, `Community 5`, `Community 10`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `AgentKind` connect `Community 3` to `Community 0`, `Community 1`, `Community 2`, `Community 5`, `Community 19`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **Why does `advanceWorkflow()` connect `Community 0` to `Community 1`, `Community 2`, `Community 19`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `advanceWorkflow()` (e.g. with `POST()` and `POST()`) actually correct?**
  _`advanceWorkflow()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `BridgeHealthStatus`, `BridgeHealth`, `HttpBridgeCheck` to the rest of the system?**
  _262 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08326530612244898 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.07585568917668825 - nodes in this community are weakly interconnected._