workspace "Jormungand Harness Framework" "C4 model for the Jormungand harness dashboard and agent orchestration workspace." {
    model {
        user = person "Operator" "Creates projects, launches workflow runs, reviews artifacts, and decides approval gates."

        codexBridge = softwareSystem "Codex Bridge" "Authenticated v0.3 Codex execution bridge bound to a configured repository workspace." "External" {
            tags "External"
        }

        openClaw = softwareSystem "OpenClaw Runtime" "Authenticated v0.3 OpenClaw HTTP bridge or optional A2A execution runtime." "External" {
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

            api = container "Next.js HTTP Boundary And API" "Site-authenticated HTTP boundary for workflow runs, projects, bridge health, and approvals, with public /health liveness." "Next.js Proxy And Route Handlers" {
                siteAuthBoundary = component "Site Auth And Liveness Boundary" "Defaults site authentication to all UI/API routes while allowing unauthenticated GET /health." "repos/jormungand/proxy.ts + app/health/route.ts"
                projectRoutes = component "Project Routes" "Create/list projects and project-scoped workflow runs." "repos/jormungand/app/api/projects/**"
                workflowRoutes = component "Workflow Run Routes" "Create, read, advance, stop, and cancel workflow runs." "repos/jormungand/app/api/workflow-runs/**"
                approvalRoutes = component "Approval Gate Routes" "Apply approval gate decisions to waiting workflow runs." "repos/jormungand/app/api/approval-gates/**"
                agentHealthRoutes = component "Protected Agent Health Routes" "Probe authenticated Codex/OpenClaw bridge health behind site auth." "repos/jormungand/app/api/agent-health/route.ts"
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
        dashboard -> api "Submits authenticated workflow and approval requests"
        dashboard -> api "Polls protected project, run, and bridge health state"
        api -> workflowEngine "Creates and advances workflow state"
        api -> workspaceStore "Reads and writes project and workflow records"
        workflowEngine -> agentBridge "Invokes configured agent executors"
        workflowEngine -> runtimeSkillResolver "Requests runtime skill bundle resolution"
        workflowEngine -> workspaceStore "Persists generated runs, artifacts, gates, events, and revisions"
        agentBridge -> codexBridge "Posts authenticated v0.3 Codex agent-run requests"
        agentBridge -> openClaw "Posts authenticated v0.3 bridge requests or sends A2A envelopes"
        agentBridge -> github "Ensures requested repositories during intake"
        runtimeSkillResolver -> workspaceStore "Uses project-local harness registry files"

        projectComposer -> workflowRoutes "Starts workflow runs"
        projectSelector -> projectRoutes "Refreshes project list"
        workflowBoard -> workflowRoutes "Advances, stops, and cancels runs"
        workflowBoard -> approvalRoutes "Submits approval decisions"
        bridgeStatusPanel -> agentHealthRoutes "Polls bridge status"

        siteAuthBoundary -> projectRoutes "Allows authenticated project requests"
        siteAuthBoundary -> workflowRoutes "Allows authenticated workflow requests"
        siteAuthBoundary -> approvalRoutes "Allows authenticated approval requests"
        siteAuthBoundary -> agentHealthRoutes "Allows authenticated health requests"

        workflowRoutes -> runFactory "Creates run"
        workflowRoutes -> stageAdvancer "Advances run"
        workflowRoutes -> stateAccess "Persists run"
        approvalRoutes -> approvalCoordinator "Records gate decision"
        approvalRoutes -> stateAccess "Persists decision"
        agentHealthRoutes -> codexBridge "Authenticated GET /health"
        agentHealthRoutes -> openClaw "Authenticated GET /health"

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

        production = deploymentEnvironment "Production" {
            deploymentNode "Operator Device" "Authenticated operator access." "Browser" {
                infrastructureNode "Operator Browser" "Uses the Zeabur HTTPS endpoint."
            }

            deploymentNode "Zeabur" "Managed application deployment." "Docker / Node.js" {
                deploymentNode "Jormungand Service" "Next.js production process. /health is public; UI, API, and /api/agent-health require site auth." "Next.js 16" {
                    containerInstance dashboard
                    containerInstance api
                    containerInstance workflowEngine
                    containerInstance agentBridge
                    containerInstance runtimeSkillResolver
                }

                deploymentNode "Container Filesystem" "Single-process JSON state; durability is not guaranteed across replacement." "Ephemeral filesystem" {
                    containerInstance workspaceStore
                }
            }

            deploymentNode "Codex Workstation" "Configured repository execution boundary." "Windows / Node.js" {
                infrastructureNode "Codex Bridge Process" "Authenticated v0.3 bridge with repository-origin guard and runtime bundle verification."
                infrastructureNode "Configured Repository Workspace" "The only repository origin accepted for Codex execution."
            }

            deploymentNode "Cloudflare" "Public OpenClaw bridge ingress." "Tunnel" {
                infrastructureNode "OpenClaw Tunnel" "Forwards the formal bridge hostname to the VM loopback service."
            }

            deploymentNode "OpenClaw VM" "OpenClaw execution host." "Linux VM" {
                infrastructureNode "jormungandr-openclaw-bridge.service" "Enabled user service bound to 127.0.0.1:4178; authenticates v0.3 requests and enforces the deployed exact skill lock."
                deploymentNode "OpenClaw Docker Runtime" "Healthy OpenClaw container." "Docker" {
                    infrastructureNode "OpenClaw Agent Runtime" "Executes Rowlet, Roaring Moon, and Charizard tasks with verified runtime skills and context files."
                }
            }

            deploymentNode "Deployment Workstation" "Maintains the OpenClaw VM bridge." "Windows / PowerShell" {
                infrastructureNode "Pinned SSH Deployer" "Uses persistent known_hosts with strict checking; synchronizes openclaw-bridge.mjs and .harness/skill.lock.json."
            }

            deploymentNode "GitHub" "Source and immutable runtime-skill distribution." "GitHub" {
                infrastructureNode "skills-v1.0.0 Release" "Hosts the checksum-locked superpowers-full runtime bundle."
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
            agentBridge -> codexBridge "POST authenticated v0.3 agent-runs (Codex path)"
            agentBridge -> openClaw "POST authenticated v0.3 agent-runs (OpenClaw alternative)"
            workflowEngine -> workspaceStore "Persist run, artifacts, gates, events"
            dashboard -> api "GET latest state"
        }

        deployment jormungand local "deploymentLocal" "Local development/runtime deployment" {
            include *
            autoLayout
        }

        deployment jormungand production "deploymentProduction" "Verified Zeabur, Codex, and OpenClaw production deployment" {
            include *
            autoLayout
        }

        theme default
    }
}
