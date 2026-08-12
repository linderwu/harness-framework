import { mkdir, writeFile } from "fs/promises"
import path from "path"

const appRoot = process.cwd()
const workspaceRoot = path.resolve(appRoot, "..", "..")
const outDir = path.join(workspaceRoot, "wiki", "c4", "diagrams")
const generatedAt = new Date().toISOString()

const theme = {
  person: "#fff4cc",
  external: "#ffe3d8",
  system: "#dff3ff",
  container: "#e6f4ea",
  component: "#eef0ff",
  storage: "#f5e6ff",
  code: "#f7f7f7"
}

const diagrams = [
  {
    key: "system-context",
    title: "System Context",
    c4Type: "System Context",
    evidence: "Evidence-backed from wiki/c4/workspace.dsl and current API/UI source files.",
    nodes: [
      node("operator", "Operator", "Creates projects, launches workflow runs, reviews artifacts, decides gates.", "person", 40, 190),
      node("jormungand", "Jormungand Harness Framework", "Dashboard and workflow orchestration for agent-assisted delivery.", "system", 360, 170, 270, 130),
      node("codex", "Codex Bridge", "Local Codex execution bridge.", "external", 780, 70),
      node("openclaw", "OpenClaw Runtime", "Optional bridge or A2A executor.", "external", 780, 220),
      node("github", "GitHub", "Repository source and intake readiness target.", "external", 780, 370)
    ],
    edges: [
      edge("operator", "jormungand", "operates"),
      edge("jormungand", "codex", "agent runs"),
      edge("jormungand", "openclaw", "optional execution"),
      edge("jormungand", "github", "repository readiness")
    ]
  },
  {
    key: "container",
    title: "Container",
    c4Type: "Container",
    evidence: "Evidence-backed from repos/jormungand/app/page.tsx, repos/jormungand/app/api/** routes, and repos/jormungand/lib/*.ts.",
    nodes: [
      node("operator", "Operator", "Uses browser UI.", "person", 30, 230),
      node("dashboard", "Harness Dashboard", "Project selection, workflow launch, artifacts, approval gates.", "container", 300, 70),
      node("api", "Next.js API Routes", "Workflow, project, approval, and bridge health HTTP API.", "container", 300, 250),
      node("engine", "Workflow Engine", "Creates/advances runs and coordinates gates.", "container", 600, 160),
      node("bridge", "Agent Bridge", "Normalizes Codex/OpenClaw/simulated executor calls.", "container", 900, 70),
      node("resolver", "Runtime Skill Resolver", "Resolves bridge protocol v0.3 skill bundles.", "container", 900, 250),
      node("store", "Workspace Store", "Local JSON-backed project and workflow state.", "storage", 600, 350),
      node("codex", "Codex Bridge", "External execution bridge.", "external", 1190, 30),
      node("openclaw", "OpenClaw Runtime", "Optional external executor.", "external", 1190, 180),
      node("github", "GitHub", "Repository source/target.", "external", 1190, 330)
    ],
    edges: [
      edge("operator", "dashboard", "operates"),
      edge("dashboard", "api", "fetch / mutate"),
      edge("api", "engine", "create/advance"),
      edge("api", "store", "read/write"),
      edge("engine", "bridge", "invoke agents"),
      edge("engine", "resolver", "resolve skills"),
      edge("engine", "store", "persist artifacts"),
      edge("bridge", "codex", "POST agent-runs"),
      edge("bridge", "openclaw", "bridge/A2A"),
      edge("bridge", "github", "ensure repo")
    ]
  },
  componentDiagram("component-dashboard", "Harness Dashboard Components", "Harness Dashboard", [
    ["composer", "Project Composer", "Collects project, agent, skills, approvals, and context files."],
    ["selector", "Project Selector", "Builds searchable project/run navigation."],
    ["board", "Workflow Board", "Shows stages, event skills, artifacts, gates, and actions."],
    ["health", "Bridge Status Panel", "Polls and displays Codex/OpenClaw bridge health."]
  ], [
    edge("operator", "composer", "creates"),
    edge("operator", "selector", "selects"),
    edge("operator", "board", "reviews/acts"),
    edge("composer", "api", "POST projects/runs"),
    edge("selector", "api", "GET projects/runs"),
    edge("board", "api", "advance/stop/cancel/approve"),
    edge("health", "api", "GET agent health")
  ]),
  componentDiagram("component-api-routes", "API Route Components", "Next.js API Routes", [
    ["projects", "Project Routes", "Create/list projects and project-scoped runs."],
    ["workflow", "Workflow Run Routes", "Create/read/advance/stop/cancel workflow runs."],
    ["approval", "Approval Gate Routes", "Apply approval decisions."],
    ["health", "Agent Health Routes", "Probe configured bridge health."]
  ], [
    edge("dashboard", "projects", "project requests"),
    edge("dashboard", "workflow", "run requests"),
    edge("dashboard", "approval", "gate decisions"),
    edge("dashboard", "health", "health polling"),
    edge("projects", "store", "read/write"),
    edge("workflow", "engine", "create/advance"),
    edge("workflow", "store", "persist"),
    edge("approval", "engine", "decide gate"),
    edge("health", "bridge", "probe bridge config")
  ]),
  componentDiagram("component-workflow-engine", "Workflow Engine Components", "Workflow Engine", [
    ["catalog", "Event Skill Catalog", "Defines skills, gates, knowledge sources, and runtime bundles."],
    ["factory", "Run Factory", "Creates normalized runs and policies."],
    ["advancer", "Stage Advancer", "Moves runs through intake to closeout."],
    ["approval", "Approval Coordinator", "Opens gates, decisions, revisions."],
    ["artifacts", "Artifact Recorder", "Writes artifacts, events, agent run audit records."]
  ], [
    edge("api", "factory", "createWorkflowRun"),
    edge("api", "advancer", "advanceWorkflow"),
    edge("advancer", "catalog", "reads skills"),
    edge("advancer", "approval", "opens gates"),
    edge("advancer", "artifacts", "records outputs"),
    edge("artifacts", "bridge", "invoke agent"),
    edge("artifacts", "resolver", "resolve bundles"),
    edge("approval", "store", "persist revisions")
  ]),
  componentDiagram("component-agent-bridge", "Agent Bridge Components", "Agent Bridge", [
    ["invoker", "Bridge Invoker", "Routes invocations to configured executor family."],
    ["intake", "Intake Repository Agent", "Ensures GitHub repository readiness."],
    ["a2a", "A2A Envelope Sender", "Builds and sends OpenClaw A2A envelopes."],
    ["control", "Bridge Control", "Sends stop/cancel controls."]
  ], [
    edge("engine", "invoker", "invokeConfiguredAgent"),
    edge("invoker", "codex", "HTTP bridge"),
    edge("invoker", "openclaw", "bridge HTTP"),
    edge("invoker", "a2a", "A2A command"),
    edge("invoker", "intake", "intake repo"),
    edge("intake", "github", "ensure repo"),
    edge("control", "codex", "stop/cancel")
  ]),
  componentDiagram("component-workspace-store", "Workspace Store Components", "Workspace Store", [
    ["file", "State File", "repos/jormungand/data/harness-state.json."],
    ["access", "State Access", "Read/write/list/upsert/delete operations."],
    ["normalize", "State Normalizer", "Legacy migration, project links, event-log status."]
  ], [
    edge("api", "access", "state operations"),
    edge("access", "file", "JSON read/write"),
    edge("access", "normalize", "normalize state"),
    edge("normalize", "file", "consistent state")
  ]),
  componentDiagram("component-runtime-skill-resolver", "Runtime Skill Resolver Components", "Runtime Skill Resolver", [
    ["reader", "Registry Reader", "Loads repos/jormungand/.harness registry and lockfile."],
    ["matcher", "Bundle Matcher", "Checks requested bundles against registry and lockfile."],
    ["reporter", "Resolution Reporter", "Returns structured success/failure audit result."]
  ], [
    edge("engine", "reader", "requests skill bundles"),
    edge("reader", "matcher", "registry + lockfile"),
    edge("matcher", "reporter", "resolution"),
    edge("reporter", "engine", "audit result")
  ]),
  {
    key: "dynamic-start-workflow-run",
    title: "Dynamic: Start Workflow Run",
    c4Type: "Dynamic",
    evidence: "Evidence-backed from repos/jormungand/app/api/workflow-runs/route.ts and repos/jormungand/lib/workflow.ts.",
    nodes: [
      node("operator", "Operator", "Submits requirement and policy.", "person", 40, 80),
      node("dashboard", "Harness Dashboard", "Collects run request.", "container", 300, 80),
      node("api", "Workflow Route", "POST /api/workflow-runs.", "component", 560, 80),
      node("engine", "Workflow Engine", "Creates and advances run.", "container", 820, 80),
      node("resolver", "Runtime Skill Resolver", "Resolves runtime bundles.", "component", 820, 260),
      node("bridge", "Agent Bridge", "Invokes configured executor.", "container", 1080, 80),
      node("store", "Workspace Store", "Persists run and artifacts.", "storage", 1080, 260),
      node("codex", "Codex Bridge", "External agent run.", "external", 1340, 80)
    ],
    edges: [
      edge("operator", "dashboard", "1. enter request"),
      edge("dashboard", "api", "2. POST run"),
      edge("api", "engine", "3. create/advance"),
      edge("engine", "resolver", "4. resolve skills"),
      edge("engine", "bridge", "5. invoke agent"),
      edge("bridge", "codex", "6. POST agent-runs"),
      edge("engine", "store", "7. persist"),
      edge("dashboard", "api", "8. refresh state")
    ]
  },
  {
    key: "deployment-local",
    title: "Deployment: Local Runtime",
    c4Type: "Deployment",
    evidence: "Partly inferred from Next.js app layout, local JSON store, and bridge environment variables.",
    nodes: [
      node("browser", "Operator Browser", "Runs Harness Dashboard UI.", "person", 60, 100),
      node("next", "Local Next.js Process", "Serves UI and route handlers.", "container", 360, 100),
      node("json", "Local State File", "repos/jormungand/data/harness-state.json.", "storage", 680, 100),
      node("codex", "Local Codex Bridge", "Optional CODEX_BRIDGE_URL process.", "external", 1000, 40),
      node("openclaw", "OpenClaw Bridge/A2A", "Optional OPENCLAW_* process or command.", "external", 1000, 220),
      node("github", "GitHub", "Network repository service.", "external", 1280, 130)
    ],
    edges: [
      edge("browser", "next", "HTTP localhost"),
      edge("next", "json", "fs read/write"),
      edge("next", "codex", "HTTP bridge"),
      edge("next", "openclaw", "HTTP or child_process"),
      edge("next", "github", "repository API")
    ]
  },
  {
    key: "code-key-abstractions",
    title: "Code-level Key Abstractions",
    c4Type: "Code",
    evidence: "Evidence-backed from graphify report and repos/jormungand/lib/types.ts plus repos/jormungand/lib/workflow.ts symbol names.",
    nodes: [
      node("workflowrun", "WorkflowRun", "Run state, stages, events, artifacts, gates, revisions.", "code", 60, 120, 260, 120),
      node("workfloweventskill", "WorkflowEventSkill", "Skill contract for event-driven workflow steps.", "code", 420, 40, 260, 120),
      node("approvalgate", "ApprovalGate", "Human or agent review gate for stage advancement.", "code", 420, 220, 260, 120),
      node("agentinput", "AgentInvocationInput", "Payload sent to configured agent executors.", "code", 780, 40, 260, 120),
      node("agentresult", "AgentArtifactResult", "Agent output normalized into artifacts and audit metadata.", "code", 780, 220, 260, 120),
      node("resolution", "RuntimeSkillResolution", "Runtime skill bundle resolution status.", "code", 1140, 130, 260, 120)
    ],
    edges: [
      edge("workflowrun", "workfloweventskill", "contains event skills"),
      edge("workflowrun", "approvalgate", "contains gates"),
      edge("workfloweventskill", "agentinput", "drives invocation"),
      edge("agentinput", "agentresult", "returns"),
      edge("workfloweventskill", "resolution", "may require bundles"),
      edge("agentresult", "workflowrun", "records artifacts")
    ]
  }
]

function node(id, label, description, type, x, y, w = 220, h = 110) {
  return { id, label, description, type, x, y, w, h }
}

function edge(from, to, label) {
  return { from, to, label }
}

function componentDiagram(key, title, containerName, components, edges) {
  const nodes = [
    node("operator", "Operator", "Uses the system.", "person", 40, 190),
    node("dashboard", "Harness Dashboard", "Browser UI.", "container", 300, 60),
    node("api", "Next.js API Routes", "HTTP API.", "container", 300, 320),
    node("engine", "Workflow Engine", "Workflow domain logic.", "container", 1080, 60),
    node("bridge", "Agent Bridge", "External executor integration.", "container", 1080, 220),
    node("resolver", "Runtime Skill Resolver", "Runtime skill bundle resolution.", "container", 1080, 380),
    node("store", "Workspace Store", "JSON-backed persistence.", "storage", 820, 380),
    node("codex", "Codex Bridge", "External bridge.", "external", 1340, 80),
    node("openclaw", "OpenClaw Runtime", "Optional executor.", "external", 1340, 240),
    node("github", "GitHub", "Repository service.", "external", 1340, 400)
  ]

  components.forEach(([id, label, description], index) => {
    const col = index % 2
    const row = Math.floor(index / 2)
    nodes.push(node(id, label, description, "component", 560 + col * 260, 70 + row * 170, 220, 120))
  })

  return {
    key,
    title,
    c4Type: "Component",
    evidence: `Evidence-backed component view for ${containerName}.`,
    nodes,
    edges
  }
}

function mermaidFor(diagram) {
  const lines = [
    "flowchart LR",
    `  %% ${diagram.title}`,
    ...diagram.nodes.map((item) => `  ${item.id}["${escapeMermaid(item.label)}<br/>${escapeMermaid(item.description)}"]`),
    ...diagram.edges.map((item) => `  ${item.from} -->|"${escapeMermaid(item.label)}"| ${item.to}`)
  ]

  return `${lines.join("\n")}\n`
}

function svgFor(diagram) {
  const width = Math.max(...diagram.nodes.map((item) => item.x + item.w)) + 80
  const height = Math.max(...diagram.nodes.map((item) => item.y + item.h)) + 100
  const nodeById = new Map(diagram.nodes.map((item) => [item.id, item]))
  const edges = diagram.edges.map((item) => {
    const from = nodeById.get(item.from)
    const to = nodeById.get(item.to)

    if (!from || !to) {
      return ""
    }

    const start = anchor(from, to)
    const end = anchor(to, from)
    const midX = (start.x + end.x) / 2
    const midY = (start.y + end.y) / 2

    return [
      `<line class="edge" x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" />`,
      `<text class="edge-label" x="${midX}" y="${midY - 6}">${escapeXml(item.label)}</text>`
    ].join("\n")
  }).join("\n")

  const nodes = diagram.nodes.map((item) => {
    const fill = theme[item.type] ?? theme.component
    const titleLines = wrap(item.label, 24)
    const descLines = wrap(item.description, 34).slice(0, 3)
    const titleText = titleLines.map((line, index) =>
      `<text class="node-title" x="${item.x + 16}" y="${item.y + 28 + index * 18}">${escapeXml(line)}</text>`
    ).join("\n")
    const descY = item.y + 34 + titleLines.length * 18
    const descText = descLines.map((line, index) =>
      `<text class="node-desc" x="${item.x + 16}" y="${descY + index * 16}">${escapeXml(line)}</text>`
    ).join("\n")

    return [
      `<rect class="node ${item.type}" x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" rx="8" fill="${fill}" />`,
      titleText,
      descText
    ].join("\n")
  }).join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(diagram.title)}</title>
  <desc id="desc">${escapeXml(diagram.evidence)}</desc>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#344054" />
    </marker>
  </defs>
  <style>
    svg { background: #ffffff; font-family: Arial, Helvetica, sans-serif; }
    .diagram-title { fill: #101828; font-size: 24px; font-weight: 700; }
    .diagram-meta { fill: #667085; font-size: 13px; }
    .node { stroke: #344054; stroke-width: 1.2; }
    .node-title { fill: #101828; font-size: 14px; font-weight: 700; }
    .node-desc { fill: #344054; font-size: 12px; }
    .edge { stroke: #344054; stroke-width: 1.4; marker-end: url(#arrow); }
    .edge-label { fill: #475467; font-size: 12px; paint-order: stroke; stroke: #ffffff; stroke-width: 4px; stroke-linejoin: round; }
  </style>
  <text class="diagram-title" x="32" y="36">${escapeXml(diagram.title)}</text>
  <text class="diagram-meta" x="32" y="58">${escapeXml(diagram.c4Type)} - ${escapeXml(diagram.evidence)}</text>
  <g class="edges">
${indent(edges, 4)}
  </g>
  <g class="nodes">
${indent(nodes, 4)}
  </g>
</svg>
`
}

function anchor(source, target) {
  const sourceCenter = { x: source.x + source.w / 2, y: source.y + source.h / 2 }
  const targetCenter = { x: target.x + target.w / 2, y: target.y + target.h / 2 }
  const dx = targetCenter.x - sourceCenter.x
  const dy = targetCenter.y - sourceCenter.y

  if (Math.abs(dx) > Math.abs(dy)) {
    return {
      x: dx > 0 ? source.x + source.w : source.x,
      y: sourceCenter.y
    }
  }

  return {
    x: sourceCenter.x,
    y: dy > 0 ? source.y + source.h : source.y
  }
}

function wrap(value, max) {
  const words = value.split(/\s+/)
  const lines = []
  let line = ""

  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length > max && line) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }

  if (line) {
    lines.push(line)
  }

  return lines
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function escapeMermaid(value) {
  return String(value).replaceAll('"', "'")
}

function indent(value, spaces) {
  const prefix = " ".repeat(spaces)
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n")
}

function htmlIndex() {
  const links = diagrams.map((diagram) => `
      <article>
        <h2>${escapeXml(diagram.title)}</h2>
        <p><strong>${escapeXml(diagram.c4Type)}</strong> - ${escapeXml(diagram.evidence)}</p>
        <p><a href="./${diagram.key}.mmd">Mermaid</a> | <a href="./${diagram.key}.svg">SVG</a></p>
        <img src="./${diagram.key}.svg" alt="${escapeXml(diagram.title)}" />
      </article>`).join("\n")

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Jormungand C4 Diagrams</title>
    <style>
      body { font-family: Arial, Helvetica, sans-serif; margin: 32px; color: #101828; }
      article { border-top: 1px solid #d0d5dd; padding: 24px 0; }
      img { max-width: 100%; border: 1px solid #d0d5dd; }
      a { color: #175cd3; }
    </style>
  </head>
  <body>
    <h1>Jormungand C4 Diagrams</h1>
    <p>Generated ${escapeXml(generatedAt)} from the Ouroboros C4 view set.</p>
${links}
  </body>
</html>
`
}

await mkdir(outDir, { recursive: true })

for (const diagram of diagrams) {
  await writeFile(path.join(outDir, `${diagram.key}.mmd`), mermaidFor(diagram))
  await writeFile(path.join(outDir, `${diagram.key}.svg`), svgFor(diagram))
}

await writeFile(path.join(outDir, "index.html"), htmlIndex())
await writeFile(
  path.join(outDir, "manifest.json"),
  `${JSON.stringify({
    schemaVersion: "ouroboros-c4-diagrams/v1",
    generatedAt,
    source: "wiki/c4/workspace.dsl",
    outputs: diagrams.map((diagram) => ({
      key: diagram.key,
      title: diagram.title,
      c4Type: diagram.c4Type,
      evidence: diagram.evidence,
      files: [
        `wiki/c4/diagrams/${diagram.key}.mmd`,
        `wiki/c4/diagrams/${diagram.key}.svg`
      ]
    })),
    index: "wiki/c4/diagrams/index.html"
  }, null, 2)}\n`
)

if (diagrams.length === 0) {
  throw new Error("No C4 diagrams were generated.")
}

console.log(`Generated ${diagrams.length} C4 diagram views in ${outDir}`)
