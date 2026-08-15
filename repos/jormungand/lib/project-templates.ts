import type { ProjectTemplate, ProjectType } from "./types"

export const projectTypeOptions: Array<{ type: ProjectType; label: string }> = [
  { type: "research", label: "Research" },
  { type: "development", label: "Development" },
  { type: "testing", label: "Testing" },
  { type: "documentation", label: "Documentation" },
  { type: "diagnosis", label: "Diagnosis" },
  { type: "decision", label: "Decision" },
  { type: "agent_task", label: "Agent Task" },
  { type: "hive_mission", label: "Hive Mission" },
  { type: "arceus_maintenance", label: "Arceus Maintenance" }
]

export const projectTemplates: Record<ProjectType, ProjectTemplate> = {
  research: {
    type: "research",
    label: "Research",
    phases: ["Brief", "Prompt", "Research", "Completed"],
    defaultArtifacts: ["requirement", "research_prompt", "research_report"],
    creationPrompts: ["Research topic", "Repository", "Research output target"],
    defaultNextAction: "Generate the research prompt."
  },
  development: {
    type: "development",
    label: "Development",
    phases: ["Intake", "Plan", "Design", "Build", "Verify", "Completed"],
    defaultArtifacts: ["requirement", "plan", "openspec", "patch", "test_report"],
    creationPrompts: ["Feature or fix", "Repository", "Acceptance criteria"],
    defaultNextAction: "Capture the development intake."
  },
  testing: {
    type: "testing",
    label: "Testing",
    phases: ["Goal", "Test Plan", "Cases", "Execute", "Report", "Completed"],
    defaultArtifacts: ["requirement", "plan", "manual_checklist", "test_report"],
    creationPrompts: ["Test goal", "Risk areas", "Evidence to collect"],
    defaultNextAction: "Define the test goal."
  },
  documentation: {
    type: "documentation",
    label: "Documentation",
    phases: ["Brief", "Outline", "Draft", "Review", "Publish", "Completed"],
    defaultArtifacts: ["requirement", "plan", "design", "log"],
    creationPrompts: ["Audience", "Document goal", "Source material"],
    defaultNextAction: "Write the documentation brief."
  },
  diagnosis: {
    type: "diagnosis",
    label: "Diagnosis",
    phases: ["Report", "Reproduce", "Diagnose", "Fix Plan", "Verify", "Completed"],
    defaultArtifacts: ["requirement", "scenario_log", "finding", "plan", "test_report"],
    creationPrompts: ["Failure report", "Reproduction path", "Known constraints"],
    defaultNextAction: "Record the problem report."
  },
  decision: {
    type: "decision",
    label: "Decision",
    phases: ["Question", "Options", "Evidence", "Tradeoff", "Record", "Completed"],
    defaultArtifacts: ["requirement", "finding", "design", "log"],
    creationPrompts: ["Decision question", "Options", "Decision owner"],
    defaultNextAction: "Frame the decision question."
  },
  agent_task: {
    type: "agent_task",
    label: "Agent Task",
    phases: ["Instruction", "Response", "Completed"],
    defaultArtifacts: ["log"],
    creationPrompts: ["Instruction"],
    defaultNextAction: "Run the agent task."
  },
  hive_mission: {
    type: "hive_mission",
    label: "Hive Mission",
    phases: ["Goal", "Plan", "Dispatch", "Monitor", "Verify", "Completed"],
    defaultArtifacts: ["requirement", "plan", "log", "test_report"],
    creationPrompts: ["Mission name", "Goal", "Success criteria", "Repository scope", "Budgets"],
    defaultNextAction: "Wake the Codex hive manager."
  },
  arceus_maintenance: {
    type: "arceus_maintenance",
    label: "Arceus Maintenance",
    phases: ["Intake", "Plan", "Modify", "Test", "Code Review", "Ready"],
    defaultArtifacts: ["requirement", "plan", "patch", "test_report", "code_review_report"],
    creationPrompts: ["Maintenance goal", "Success criteria", "Constraints", "Non-goals"],
    defaultNextAction: "Let Codex inspect Jormungand."
  }
}

export function getProjectTemplate(type: ProjectType): ProjectTemplate {
  if (type in projectTemplates) {
    return projectTemplates[type]
  }

  return {
    ...projectTemplates.development,
    warning: `Unknown project type "${String(type)}" normalized to development.`
  }
}
