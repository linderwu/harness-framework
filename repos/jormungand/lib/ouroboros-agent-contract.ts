export const ouroborosAgentContract = `# Agent Instructions

## Ouroboros Knowledge Protocol

This repository is Ouroboros-aware. Before substantial work, agents must run
the Ouroboros preflight and use the result to decide how much knowledge
infrastructure is worth activating.

### Preflight

1. Count important source files, excluding dependencies and generated output.
   Count product source such as .ts, .tsx, .js, .jsx, .py, .go, .rs, .java,
   .cpp, and .h files.
2. Choose the operating level:
   - S (<5 important source files): do not activate full Ouroboros. Read the
     code directly and avoid creating knowledge-bureaucracy.
   - M (5-20 files): use lightweight Ouroboros. Preserve evidence in raw/,
     maintain focused spec/ contracts, and use graphify only on hub modules.
   - L (>20 files): use full Ouroboros. Maintain raw/, graphify/, wiki/, and
     spec/ as the repository knowledge layers.
3. If the repo is near a boundary, treat high coupling, cross-module calls, or
   repeated agent rereads as a reason to move one level up.

### Question Routing

- Evidence, original requirements, PM specs, meeting notes, external references,
  and verification logs belong in raw/. raw/ is append-only.
- Dependency impact, call graph questions, and ?hat changes if I touch this???  go through graphify/ when the selected operating level enables it.
- Durable design rationale, procedural architecture, decisions, tradeoffs,
  runtime patterns, and comparisons belong in wiki/.
- Current code-derived contracts, API shapes, module interfaces, data flow, and
  edge cases belong in spec/.
- Source changes happen in the source tree. Do not put code in raw/.

### Update Rules

- New user-approved requirements, external references, or validation evidence:
  append a new dated file under raw/.
- API, module, or data-flow changes: update the relevant spec/ contract.
- New durable design rationale: draft a wiki/concepts/ page that cites raw/
  evidence. Do not treat an uncited generated explanation as truth.
- Debug lessons or repeated operational clues: draft wiki/patterns/.
- Option tradeoffs: draft wiki/comparisons/.
- Code changes in M/L repos should trigger a graphify refresh when graphify is
  part of the selected operating level.

### Guardrails

- Never rewrite, delete, or overwrite raw/ evidence.
- Never create wiki/raw/ or any parallel evidence layer.
- Never auto-merge generated wiki decisions. Wiki pages are curated knowledge
  and should be reviewed before becoming active.
- Never run full graphify for tiny repos where direct reading is cheaper.
- Never update wiki for every small edit. Use wiki only for durable knowledge
  that future agents should intentionally recall.
`
