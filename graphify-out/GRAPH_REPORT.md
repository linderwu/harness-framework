# Graph Report - repos\jormungand  (2026-08-13)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 500 nodes · 985 edges · 31 communities (24 shown, 7 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 48 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `52a020e0`
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
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]

## God Nodes (most connected - your core abstractions)
1. `advanceWorkflow()` - 28 edges
2. `invokeConfiguredAgent()` - 17 edges
3. `WorkflowRun` - 17 edges
4. `compilerOptions` - 16 edges
5. `getAgentProfile()` - 15 edges
6. `upsertWorkflowRun()` - 14 edges
7. `normalizeAgentKind()` - 13 edges
8. `decideApprovalGate()` - 13 edges
9. `AgentKind` - 12 edges
10. `readState()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `Charizard Agent Image` --references--> `Jormungand App Project`  [INFERRED]
  public/agents/charizard.webp → README.md
- `Ouroboros Background Branding Image` --references--> `Ouroboros Workspace`  [INFERRED]
  public/branding/ouroboros-background.jpg → README.md
- `POST()` --calls--> `decideApprovalGate()`  [INFERRED]
  app/api/approval-gates/[id]/decide/route.ts → lib/workflow.ts
- `POST()` --calls--> `advanceWorkflow()`  [INFERRED]
  app/api/projects/[id]/workflow-runs/route.ts → lib/workflow.ts
- `POST()` --calls--> `advanceWorkflow()`  [INFERRED]
  app/api/workflow-runs/[id]/advance/route.ts → lib/workflow.ts

## Import Cycles
- None detected.

## Communities (31 total, 7 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.09
Nodes (46): stopConfiguredAgentRun(), ApprovalGate, actorLabels, addAgentArtifact(), addWorkflowEvent(), advanceAgentTask(), advanceWorkflow(), AgentInvoker (+38 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (52): asRecord(), BridgeLikeResponse, collectArtifactsText(), collectLegacyPayloadText(), collectMessageText(), collectPartsText(), createLegacyClawCodexEnvelope(), createOpenClawA2AEnvelope() (+44 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (35): buildProjectOverview(), getProjectTemplate(), projectTemplates, projectTypeOptions, AgentRun, ApprovalPolicy, ApprovalStatus, ArtifactType (+27 more)

### Community 3 - "Community 3"
Cohesion: 0.10
Nodes (37): POST(), POST(), POST(), Home(), POST(), POST(), GET(), cancelConfiguredAgentRun() (+29 more)

### Community 4 - "Community 4"
Cohesion: 0.08
Nodes (30): activeAgentRuns, activeIdempotencyKeys, activeWorkflowRuns, asList(), buildPrompt(), downloadFile(), extractTgz(), fileExists() (+22 more)

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (15): AgentHealthResponse, ApprovalDecision, BridgeHealth, BridgeHealthStatus, BridgeId, BridgePanelStatus, BridgeStatusPanel(), defaultEventSkills (+7 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (21): activeIdempotencyKeys, activeRuns, activeWorkflowRuns, downloadFile(), extractOpenClawText(), fileExists(), formatError(), installRuntimeSkillBundle() (+13 more)

### Community 7 - "Community 7"
Cohesion: 0.07
Nodes (27): dependencies, lucide-react, next, react, react-dom, devDependencies, eslint, eslint-config-next (+19 more)

### Community 8 - "Community 8"
Cohesion: 0.18
Nodes (21): assertValidRepositorySegment(), createOrganizationRepository(), createRepositoryPayload(), createUserRepository(), ensureGitHubRepository(), ensureRepositoryWithApi(), ensureRepositoryWithCli(), fetchGitHubRepository() (+13 more)

### Community 9 - "Community 9"
Cohesion: 0.16
Nodes (13): buildProjectSelectorItems(), compareActivityDescending(), formatAbsoluteActivityTime(), formatRelativeActivityTime(), getProjectCompositeStatus(), parseActivityTime(), ProjectSelectorFilter, ProjectSelectorItem (+5 more)

### Community 10 - "Community 10"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 11 - "Community 11"
Cohesion: 0.14
Nodes (12): appRoot, componentDiagram(), diagrams, escapeXml(), generatedAt, htmlIndex(), indent(), node() (+4 more)

### Community 12 - "Community 12"
Cohesion: 0.12
Nodes (18): Charizard Agent Image, Ouroboros Background Branding Image, Basic Authentication Protection, Codex Bridge Command, graphify/ Knowledge Layer, /health Liveness Endpoint, Jormungand App Project, Next.js Application (+10 more)

### Community 13 - "Community 13"
Cohesion: 0.20
Nodes (13): failure(), matchesRegistryVersion(), resolveRuntimeSkillBundles(), RuntimeSkillLockedBundle, RuntimeSkillLockfile, RuntimeSkillRegistry, RuntimeSkillRegistryBundle, RuntimeSkillRegistryVersion (+5 more)

### Community 14 - "Community 14"
Cohesion: 0.31
Nodes (8): normalizeSiteAuthMode(), shouldRequireSiteAuthentication(), SiteAuthMode, unsafeHttpMethods, config, constantTimeEquals(), hasValidBasicAuth(), proxy()

### Community 15 - "Community 15"
Cohesion: 0.32
Nodes (7): BridgeHealth, BridgeHealthStatus, checkHttpBridge(), createHttpBridgeCheck(), GET(), HttpBridgeCheck, normalizeUrl()

### Community 16 - "Community 16"
Cohesion: 0.33
Nodes (5): codexBridgeSource, healthSource, openClawBridgeSource, openClawDeploySource, proxySource

### Community 17 - "Community 17"
Cohesion: 0.83
Nodes (3): Convert-ToWslPath(), Get-SshPassword(), Invoke-Remote()

### Community 18 - "Community 18"
Cohesion: 0.50
Nodes (4): getContextFilePath(), isTextContextFile(), readFileAsBase64(), readProjectContextFile()

### Community 22 - "Community 22"
Cohesion: 0.67
Nodes (3): BridgeStatusCard(), formatBridgeCheckedAt(), getBridgePanelStatus()

### Community 23 - "Community 23"
Cohesion: 0.50
Nodes (4): HarnessDashboard(), isCancelableStatus(), isStoppableStatus(), getAgentLabel()

## Knowledge Gaps
- **127 isolated node(s):** `BridgeHealthStatus`, `BridgeHealth`, `HttpBridgeCheck`, `metadata`, `orderedStages` (+122 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WorkflowRun` connect `Community 1` to `Community 0`, `Community 2`, `Community 3`, `Community 5`, `Community 9`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `AgentKind` connect `Community 1` to `Community 0`, `Community 2`, `Community 3`, `Community 5`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **Why does `advanceWorkflow()` connect `Community 0` to `Community 2`, `Community 3`, `Community 23`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `advanceWorkflow()` (e.g. with `POST()` and `POST()`) actually correct?**
  _`advanceWorkflow()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `BridgeHealthStatus`, `BridgeHealth`, `HttpBridgeCheck` to the rest of the system?**
  _127 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08705882352941176 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08458646616541353 - nodes in this community are weakly interconnected._