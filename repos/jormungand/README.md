# Jormungand App Project

This directory is the runnable Next.js application root inside the Ouroboros
workspace.

Run app commands here:

```powershell
npm run dev
npm run codex-bridge
npm run openclaw-bridge
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

The app protects all routes with Basic authentication by default. `/health` is
the unauthenticated liveness endpoint for Zeabur. Set `SITE_AUTH_MODE=mutations`
only when public read-only access is intentional.

The OpenClaw HTTP bridge uses `OPENCLAW_BRIDGE_TOKEN`; when that value is blank,
the app can reuse `OPENCLAW_GATEWAY_TOKEN` for compatibility with an existing
single-secret deployment. Separate tokens remain preferable for new installs.
