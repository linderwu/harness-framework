# Jormungand App Project

This directory is the runnable Next.js application root inside the Ouroboros
workspace.

Run app commands here:

```powershell
npm run dev
npm run test
npm run lint
npm run typecheck
npm run build
npm run c4:diagrams
```

Generated C4 diagrams are written to the workspace root:

```text
../../wiki/c4/diagrams/
```

The workspace root still owns durable Ouroboros knowledge layers such as
`raw/`, `wiki/`, `spec/`, `graphify/`, and `graphify-out/`.
