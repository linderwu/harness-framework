# Pokemon Center Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one safe PowerShell entry point that starts and verifies the local Lucky and Codex bridge stack.

**Architecture:** The new coordinator directly starts the existing Node service entry points. It loads the existing environment/config, applies token fallbacks, starts Lucky before Codex, waits for authenticated local health, and checks the public Codex health endpoint. The existing one-service PowerShell launchers remain unchanged for manual use.

**Tech Stack:** PowerShell, Node.js bridge processes, existing Harness bridge HTTP health endpoints.

---

### Task 1: Add the Pokemon Center coordinator

**Files:**
- Create: `repos/jormungand/scripts/start-pokemon-center-server.ps1`

- [ ] **Step 1: Load environment values**

Load the project `.env.local` without overwriting already-set process values, skip empty values and unresolved `${...}` placeholders, then set `HARNESS_BRIDGE_TOKEN` from `CODEX_BRIDGE_TOKEN` and `LUCKY_BRIDGE_TOKEN` from the shared bridge token when those values are absent.

- [ ] **Step 2: Start both Node services in dependency order**

Check each local health endpoint first. If unhealthy, start `scripts/lucky-mavis-server.mjs` as a detached Node process on port `4198`, wait for authenticated health, then start `scripts/codex-bridge.mjs` as a detached Node process on port `4177` and wait for authenticated health. Save stdout/stderr under `repos/jormungand/logs/` and fail if a port is occupied by an unhealthy process.

- [ ] **Step 3: Verify the public endpoint**

Unless `-SkipPublicVerification` is supplied, call `${CODEX_BRIDGE_URL}/health` with the Codex bridge token and fail if it does not become healthy before the retry deadline.

- [ ] **Step 4: Report a non-secret summary**

Print local protocol/backend information and public status without printing any token, password, GitHub credential, or backend key.

### Task 2: Start and verify the stack

**Files:**
- Verify: `repos/jormungand/scripts/start-pokemon-center-server.ps1`
- Verify: `repos/jormungand/.env.local`
- Verify: `repos/jormungand/.harness/bridge.config.json`

- [ ] **Step 1: Run the coordinator**

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\repos\jormungand\scripts\start-pokemon-center-server.ps1`.

- [ ] **Step 2: Confirm local health**

Expect authenticated `HTTP 200` health responses on `127.0.0.1:4198` and `127.0.0.1:4177`.

- [ ] **Step 3: Confirm public Codex health**

Expect authenticated `HTTP 200` from `CODEX_BRIDGE_URL/health`.
