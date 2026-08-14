---
title: Secure Bridge Deployment Verification for Commit 52a020e
type: raw
tags: [deployment, codex, openclaw, zeabur, runtime-skills]
source: local-command-and-production-smoke-output
ingested-by: codex
trust: verified
sanitized: yes
created: 2026-08-13
updated: 2026-08-13
---

# Secure Bridge Deployment Verification for Commit 52a020e

> This file lives in the Evidence Layer (`raw/`). It is immutable and append-only.
> Do not rewrite, overwrite, or delete. To supersede it, create a new dated evidence file.

## Scope

This evidence records the sanitized verification of commit
`52a020e0a538aeaf74929ea3108de68a48135475`, pushed to `main` as
`Restore secure Codex and OpenClaw workflows`.

No token, password, SSH credential, or complete authentication header is stored
in this page.

## Build And Test Evidence

- Unit and contract tests: 55 passed, 0 failed.
- TypeScript typecheck: passed.
- ESLint: passed.
- Next.js production build: passed on Next.js 16.3.0.
- `npm audit`: 0 known vulnerabilities.
- Codex and OpenClaw bridge scripts passed Node syntax checks.
- The OpenClaw deployment PowerShell script passed parser validation.

## Runtime Skill Evidence

- GitHub release: `skills-v1.0.0`.
- Bundle: `superpowers-full-1.0.0.tgz`.
- SHA-256:
  `c9b1d3ece463869d22d8c560b50a3082e5dede290126b84c07461869b509ee8d`.
- Registry and lockfile contain the release descriptor and real checksum.
- Codex workflow execution reported the bundle as verified.
- OpenClaw workflow execution reported the bundle as verified.
- A negative OpenClaw request with a mismatched checksum was rejected as
  `bundle_not_locked` before agent execution.

## Production Topology Evidence

- Zeabur public liveness endpoint `/health` returned HTTP 200.
- The root UI and `/api/projects` returned HTTP 401 without site credentials.
- Authenticated `/api/agent-health` reported both configured bridges online on
  `harness-agent-bridge/v0.3`.
- Codex bridge health required bearer authentication and did not disclose its
  configured repository path.
- OpenClaw bridge health required bearer authentication.
- The OpenClaw VM user service `jormungandr-openclaw-bridge.service` was enabled
  and active on loopback port 4178.
- The superseded root service was disabled and inactive.
- A Cloudflare tunnel forwarded the formal OpenClaw bridge hostname to the VM
  service.
- The OpenClaw container was healthy and reachable from the bridge service.
- VM deployment used SSH host-key pinning and synchronized both the bridge
  implementation and the approved runtime-skill lockfile.

## End-to-End Evidence

The production Zeabur API completed all of the following against real bridge
transports:

- Codex Agent Task.
- Codex Project Workflow through the real plan-stage bridge call.
- OpenClaw Rowlet Agent Task.
- OpenClaw Rowlet Project Workflow through the real plan-stage bridge call.
- OpenClaw Roaring Moon Agent Task.
- OpenClaw Charizard Agent Task with a context file.
- Research, Testing, Documentation, Diagnosis, and Decision project-template
  creation checks.

The production endpoint was checked once per minute for ten minutes. The new
deployment became ready during the second check and remained stable through the
tenth check.

## References

- [[wiki/entities/agent-bridge]]
- [[wiki/c4/deployment]]
- [[spec/agent-bridge/SPEC]]
- [[spec/SPEC]]
