# Pokemon Center Server Design

## Goal

Provide one PowerShell entry point that starts the local Lucky/MiniMax server and Codex Bridge in dependency order, loads the existing environment/configuration, and reports local plus public health status without embedding secrets.

## Architecture

`start-pokemon-center-server.ps1` is the single runtime entry point. It loads `.env.local`, applies the existing bridge-token fallbacks, starts the two Node services directly on ports `4198` and `4177`, waits through startup races, and optionally verifies `CODEX_BRIDGE_URL/health`. The existing per-service launchers remain available for manual one-service operation but are not nested by the coordinator.

## Configuration

All values come from `.env.local` and `.harness/bridge.config.json`. The coordinator does not print secret values or write them. `CODEX_BRIDGE_TOKEN` may supply the local `HARNESS_BRIDGE_TOKEN` and `LUCKY_BRIDGE_TOKEN` fallbacks; `LUCKY_BACKEND_TOKEN` remains a separate MiniMax credential.

## Verification

The command must report healthy local responses for Lucky and Codex, and, unless public verification is skipped, a healthy authenticated response from `CODEX_BRIDGE_URL`.

## Non-goals

This change does not alter the bridge protocol, API routes, Cloudflare tunnel, backend model, or existing per-service launchers.
