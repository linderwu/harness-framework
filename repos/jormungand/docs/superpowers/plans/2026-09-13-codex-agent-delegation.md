# Codex Native Agent Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded `dsh_agent_call` MCP tool to DSH-routed Codex sessions so Codex can call registered Pi/OpenClaw agents without receiving bridge secrets.

**Architecture:** The Codex Bridge injects a per-session stdio MCP server through `codex app-server` config overrides. The MCP server resolves allowlisted targets from environment and calls the existing DSH v1 receipt/event API; the DSH plugin and direct Codex route remain unchanged.

**Tech Stack:** Node.js ESM, raw JSONL MCP stdio protocol, Codex App Server, existing DSH v1 HTTP bridge, `node:test`, PowerShell/Windows process launch.

---

### Task 1: MCP delegation service contract

**Files:**
- Create: `repos/jormungand/scripts/dsh/agent-call-mcp.mjs`
- Test: `repos/jormungand/tests/dsh-v1/agent-call-mcp.test.mjs`

- [ ] Write failing tests for tool inventory, configured target validation, one session/turn call, bounded polling, and unknown/timeout results.
- [ ] Run the focused test and confirm it fails because the module is absent.
- [ ] Implement the raw JSONL MCP server and injectable delegation service.
- [ ] Run the focused test until green.

### Task 2: Inject the MCP server into DSH Codex sessions

**Files:**
- Modify: `repos/jormungand/scripts/codex-models.mjs`
- Modify: `repos/jormungand/scripts/codex-bridge.mjs`
- Test: `repos/jormungand/tests/codex-app-server-model.test.mjs` and `repos/jormungand/tests/agent-bridge-source.test.ts`

- [ ] Add a failing argument-contract test for a DSH-only MCP config.
- [ ] Implement TOML-safe `-c mcp_servers...` argument construction.
- [ ] Pass delegation options only from the DSH v1 Codex session factory.
- [ ] Keep legacy sessions, model catalog probes, and quota probes unchanged.
- [ ] Run focused tests and syntax/type checks.

### Task 3: Live fake-runtime integration

**Files:**
- Modify: `repos/jormungand/tests/dsh-v1/agent-call-mcp.test.mjs`
- Create if needed: `repos/jormungand/tests/dsh-v1/fixtures/agent-call-mcp-server.mjs`

- [ ] Start the real Codex App Server with the real MCP server and a fake DSH v1 target.
- [ ] Require one tool call and verify the exact nested response and no secret leakage.
- [ ] Verify self-delegation and timeout paths remain blocked.

### Task 4: Production local bridge and DSH web verification

**Files:**
- No production DSH UI changes expected; use runtime configuration only.
- Evidence: `repos/jormungand/docs/superpowers/evidence/native-agents/`

- [ ] Run the full DSH v1 and bridge test suites.
- [ ] Restart the local bridge with delegation enabled and the Pi workspace mapping.
- [ ] Through an authenticated DSH web session, select Codex and prompt it to call Pi.
- [ ] Verify Codex emits an MCP tool item and the delegated result is visible/settled.
- [ ] Record Pi credential or OpenClaw network blockers separately from bridge correctness.

### Task 5: Quality and release

- [ ] Run typecheck, lint, focused tests, and artifact/build verification.
- [ ] Review the diff for credentials, arbitrary URL input, retry hazards, and self-recursion.
- [ ] Commit intentional files only.
- [ ] Merge/push `main` for both repositories if production verification is complete.
