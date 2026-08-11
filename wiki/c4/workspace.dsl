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
            dashboard = container "Harness Dashboard" "Browser UI for project selection, workflow launch, artifacts, and approval gates." "Next.js / React"
            api = container "Next.js API Routes" "HTTP API for workflow runs, projects, agent health, and approval decisions." "Next.js Route Handlers"
            workflowEngine = container "Workflow Engine" "Creates and advances workflow runs, emits artifacts, and coordinates approval gates." "TypeScript"
            agentBridge = container "Agent Bridge" "Normalizes Codex, OpenClaw bridge, OpenClaw A2A, and simulated executor interactions." "TypeScript / HTTP / child_process"
            workspaceStore = container "Workspace Store" "Persists project and workflow state in local JSON-backed storage." "TypeScript"
            runtimeSkillResolver = container "Runtime Skill Resolver" "Resolves runtime skill bundles for Codex bridge protocol v0.3." "TypeScript"
        }

        user -> dashboard "Operates project and workflow controls"
        dashboard -> api "Submits workflow and approval requests"
        api -> workflowEngine "Creates and advances workflow state"
        api -> workspaceStore "Reads and writes project and workflow records"
        workflowEngine -> agentBridge "Invokes configured agent executors"
        workflowEngine -> runtimeSkillResolver "Requests runtime skill bundle resolution"
        agentBridge -> codexBridge "Posts Codex agent-run requests"
        agentBridge -> openClaw "Posts bridge requests or sends A2A envelopes"
        agentBridge -> github "Ensures requested repositories during intake"
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

        theme default
    }
}
