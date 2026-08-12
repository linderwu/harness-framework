workspace "Jormungand Harness Framework" "C4 model for the Jormungand harness dashboard and agent orchestration workspace." {
    model {
        user = person "Operator" "Creates projects, launches workflow runs, reviews artifacts, and decides approval gates."

        codexBridge = softwareSystem "Codex Bridge" "Local Codex execution bridge." "External" {
            tags "External"
        }

        openClaw = softwareSystem "OpenClaw Runtime" "Optional OpenClaw bridge or A2A execution runtime." "External" {
            tags "External"
        }

        github = softwareSystem "GitHub" "Repository source and optional project repository target." "External" {
            tags "External"
        }

        jormungand = softwareSystem "Jormungand Harness Framework" "Dashboard and workflow orchestration surface for agent-assisted project delivery." {
            dashboard = container "Harness Dashboard" "Browser UI for project selection, workflow launch, artifacts, and approval gates." "Next.js / React" {
                projectComposer = component "Project Composer" "Collects project/run input, selected agent, skill assignments, approval policy, and context files." "React state and forms"
                projectSelector = component "Project Selector" "Builds searchable project/run navigation from workspace state." "React + project-selector helpers"
                workflowBoard = component "Workflow Board" "Displays stages, event skills, artifacts, gates, and run actions." "React"
                bridgeStatusPanel = component "Bridge Status Panel" "Polls bridge health and shows Codex/OpenClaw runtime status." "React + fetch"
            }

            api = container "Next.js API Routes" "HTTP API for workflow runs, projects, agent health, and approval decisions." "Next.js Route Handlers" {
                projectRoutes = component "Project Routes" "Create/list projects and project-scoped workflow runs." "repos/jormungand/app/api/projects/**"
                workflowRoutes = component "Workflow Run Routes" "Create, read, advance, stop, and cancel workflow runs." "repos/jormungand/app/api/workflow-runs/**"
                approvalRoutes = component "Approval Gate Routes" "Apply approval gate decisions to waiting workflow runs." "repos/jormungand/app/api/approval-gates/**"
                agentHealthRoutes = component "Agent Health Routes" "Probe configured Codex/OpenClaw bridge health." "repos/jormungand/app/api/agent-health/route.ts"
            }

            workflowEngine = container "Workflow Engine" "Creates and advances workflow runs, emits artifacts, and coordinates approval gates." "TypeScript" {
                eventSkillCatalog = component "Event Skill Catalog" "Defines workflow event skills, gates, knowledge sources, and runtime bundle requirements." "createDefaultEventSkills()"
                runFactory = component "Run Factory" "Creates normalized workflow runs with stage modes, skill assignments, and approval policies." "createWorkflowRun()"
                stageAdvancer = component "Stage Advancer" "Moves runs through intake, plan, design, implementation, verification, and closeout." "advanceWorkflow()"
                approvalCoordinator = component "Approval Coordinator" "Opens gates, records decisions, creates revisions, and resolves active revisions." "decideApprovalGate()"
                artifactRecorder = component "Artifact Recorder" "Creates artifacts, workflow events, agent run records, and event-log consistency status." "addAgentArtifact()"
            }

            agentBridge = container "Agent Bridge" "Normalizes Codex, OpenClaw bridge, OpenClaw A2A, and simulated executor interactions." "TypeScript / HTTP / child_process" {
                bridgeInvoker = component "Bridge Invoker" "Routes workflow event skill invocations to Codex, OpenClaw bridge, OpenClaw A2A, or simulated fallback." "invokeConfiguredAgent()"
                intakeRepositoryAgent = component "Intake Repository Agent" "Ensures requested GitHub repositories during intake." "invokeIntakeAgent()"
                a2aEnvelopeSender = component "A2A Envelope Sender" "Builds and sends OpenClaw A2A envelopes through a configured command." "invokeOpenClawA2A()"
                bridgeControl = component "Bridge Control" "Sends stop/cancel controls to configured agent bridges." "sendConfiguredAgentControl()"
            }

            workspaceStore = container "Workspace Store" "Persists project and workflow state in local JSON-backed storage." "TypeScript" {
                stateFile = component "State File" "Stores harness state in repos/jormungand/data/harness-state.json." "JSON"
                stateAccess = component "State Access" "Reads, writes, lists, and upserts projects and workflow runs." "repos/jormungand/lib/store.ts"
                stateNormalizer = component "State Normalizer" "Normalizes legacy runs, project links, warnings, and event-log consistency." "repos/jormungand/lib/workspace.ts"
            }

            runtimeSkillResolver = container "Runtime Skill Resolver" "Resolves runtime skill bundles for Codex bridge protocol v0.3." "TypeScript" {
                registryReader = component "Registry Reader" "Loads repos/jormungand/.harness/skill-registry.json and skill.lock.json." "Node fs"
                bundleMatcher = component "Bundle Matcher" "Verifies requested runtime bundles against approved registry and lockfile entries." "resolveRuntimeSkillBundles()"
                resolutionReporter = component "Resolution Reporter" "Returns structured success or failure for runtime skill bundle resolution." "RuntimeSkillResolution"
            }
        }

        user -> dashboard "Operates project and workflow controls"
        dashboard -> api "Submits workflow and approval requests"
        dashboard -> api "Polls project, run, and bridge health state"
        api -> workflowEngine "Creates and advances workflow state"
        api -> workspaceStore "Reads and writes project and workflow records"
        workflowEngine -> agentBridge "Invokes configured agent executors"
        workflowEngine -> runtimeSkillResolver "Requests runtime skill bundle resolution"
        workflowEngine -> workspaceStore "Persists generated runs, artifacts, gates, events, and revisions"
        agentBridge -> codexBridge "Posts Codex agent-run requests"
        agentBridge -> openClaw "Posts bridge requests or sends A2A envelopes"
        agentBridge -> github "Ensures requested repositories during intake"
        runtimeSkillResolver -> workspaceStore "Uses project-local harness registry files"

        projectComposer -> workflowRoutes "Starts workflow runs"
        projectSelector -> projectRoutes "Refreshes project list"
        workflowBoard -> workflowRoutes "Advances, stops, and cancels runs"
        workflowBoard -> approvalRoutes "Submits approval decisions"
        bridgeStatusPanel -> agentHealthRoutes "Polls bridge status"

        workflowRoutes -> runFactory "Creates run"
        workflowRoutes -> stageAdvancer "Advances run"
        workflowRoutes -> stateAccess "Persists run"
        approvalRoutes -> approvalCoordinator "Records gate decision"
        approvalRoutes -> stateAccess "Persists decision"
        agentHealthRoutes -> bridgeInvoker "Uses configured bridge URLs"

        stageAdvancer -> eventSkillCatalog "Reads workflow skill definitions"
        stageAdvancer -> artifactRecorder "Records stage artifacts and events"
        stageAdvancer -> approvalCoordinator "Opens approval gates"
        artifactRecorder -> bridgeInvoker "Requests agent artifacts"
        artifactRecorder -> bundleMatcher "Resolves runtime skill bundles"
        bridgeInvoker -> intakeRepositoryAgent "Handles intake repository readiness"
        bridgeInvoker -> a2aEnvelopeSender "Sends OpenClaw A2A requests"
        bridgeControl -> codexBridge "Stops or cancels configured runs"

        stateAccess -> stateFile "Reads and writes"
        stateAccess -> stateNormalizer "Normalizes persisted state"
        registryReader -> bundleMatcher "Provides registry and lockfile"
        bundleMatcher -> resolutionReporter "Returns audit result"

        local = deploymentEnvironment "Local" {
            deploymentNode "Developer Workstation" "Operator machine running the harness locally." "Windows / Node.js" {
                deploymentNode "Browser" "Operator browser session." "Chrome or equivalent" {
                    infrastructureNode "Browser Runtime" "Renders the Harness Dashboard UI."
                }

                deploymentNode "Next.js Process" "Local Next.js application process." "Node.js" {
                    containerInstance dashboard
                    containerInstance api
                    containerInstance workflowEngine
                    containerInstance agentBridge
                    containerInstance runtimeSkillResolver
                }

                deploymentNode "Local Filesystem" "Project workspace files." "JSON files" {
                    containerInstance workspaceStore
                }
            }

            deploymentNode "Configured External Services" "Optional services reached through environment variables or network APIs." "External" {
                infrastructureNode "Codex Bridge Endpoint" "CODEX_BRIDGE_URL when configured."
                infrastructureNode "OpenClaw Bridge Or A2A Command" "OPENCLAW_BRIDGE_URL or OPENCLAW_A2A_COMMAND when configured."
                infrastructureNode "GitHub API" "Repository readiness and source repository access."
            }
        }
    }

    views {
        systemContext jormungand "systemContext" {
            include *
            autoLayout
        }

        container jormungand "container" {
            include *
            autoLayout
        }

        component dashboard "componentDashboard" {
            include *
            autoLayout
        }

        component api "componentApiRoutes" {
            include *
            autoLayout
        }

        component workflowEngine "componentWorkflowEngine" {
            include *
            autoLayout
        }

        component agentBridge "componentAgentBridge" {
            include *
            autoLayout
        }

        component workspaceStore "componentWorkspaceStore" {
            include *
            autoLayout
        }

        component runtimeSkillResolver "componentRuntimeSkillResolver" {
            include *
            autoLayout
        }

        dynamic jormungand "dynamicStartWorkflowRun" "Start and advance a workflow run" {
            user -> dashboard "Enters project requirement and execution policy"
            dashboard -> api "POST /api/workflow-runs"
            api -> workflowEngine "createWorkflowRun() and advanceWorkflow()"
            workflowEngine -> runtimeSkillResolver "Resolve runtime skill bundles"
            workflowEngine -> agentBridge "Invoke configured agent"
            agentBridge -> codexBridge "POST agent-runs"
            workflowEngine -> workspaceStore "Persist run, artifacts, gates, events"
            dashboard -> api "GET latest state"
        }

        deployment jormungand local "deploymentLocal" "Local development/runtime deployment" {
            include *
            autoLayout
        }

        theme default
    }
}
