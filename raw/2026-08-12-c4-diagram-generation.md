---
title: C4 Diagram Generation Verification
type: evidence
created: 2026-08-12
---

# C4 Diagram Generation Verification

## Context

The Ouroboros skill now requires C4 work to generate verifiable diagram
artifacts instead of stopping at `wiki/c4/workspace.dsl`.

## Commands

```text
npm.cmd run c4:diagrams
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('wiki/c4/diagrams/manifest.json','utf8')); const missing=[]; for (const o of m.outputs) for (const f of o.files) { const s=fs.statSync(f); if (!s.size) missing.push(f); } const files=fs.readdirSync('wiki/c4/diagrams').filter(f=>/\.(mmd|svg)$/.test(f)); console.log(JSON.stringify({views:m.outputs.length,diagramFiles:files.length,indexExists:fs.existsSync(m.index),missing},null,2)); if (m.outputs.length !== 11 || files.length !== 22 || !fs.existsSync(m.index) || missing.length) process.exit(1);"
```

## Result

```json
{
  "views": 11,
  "diagramFiles": 22,
  "indexExists": true,
  "missing": []
}
```

## Output Directory

`wiki/c4/diagrams/`
