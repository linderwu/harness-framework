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
npm run memory:backup
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

Set `JORMUNGAND_AGENT_PERMISSION_MODE=full` to select the shared full-access
agent permission contract. In full mode, the Codex bridge disables Codex
sandboxing and Codex app-server approval pauses, workflow approval gates are
bypassed, and managed `request_approval` actions remain in audit without
parking the run. Set `restricted` to keep the approval-gated workflow and
manager behavior. Site Basic authentication remains enabled.

The OpenClaw HTTP bridge uses `OPENCLAW_BRIDGE_TOKEN`; when that value is blank,
the app can reuse `OPENCLAW_GATEWAY_TOKEN` for compatibility with an existing
single-secret deployment. Separate tokens remain preferable for new installs.

## Hive memory operations

Hive memory, manager checkpoints, and task conversation entries use SQLite in
WAL mode. Production must set:

```text
JORMUNGAND_DATA_DIR=/app/repos/jormungand/data
```

Mount a provider-managed persistent volume at that directory. The Docker
`VOLUME` declaration documents the mount point but does not itself provide
durable storage. The JSON workflow state remains in the same configured data
directory and must be included in volume-level backups.

Schedule `npm run memory:backup` daily. It creates an online SQLite backup in
`$JORMUNGAND_DATA_DIR/backups`, checks its integrity, and retains the latest 14
timestamped backups. In an isolated verification environment, run this weekly:

```powershell
npm run memory:verify-backup -- data/backups/hive-memory-YYYYMMDD-HHmmss.sqlite
```

The verifier copies the backup to a temporary directory and never overwrites
the live database. Check `/api/hive-memory/health` for schema version, database
location, latest backup time, and the latest integrity result. If startup or
health reports `unavailable`, stop autonomous managed work, preserve both the
SQLite files and JSON workflow state, verify the newest backup, and restore only
in a separate recovery procedure before resuming manager wakes.
