# Unbound Codex Model Persistence Design

**Date:** 2026-08-29

## Goal

Persist the selected Codex model for an unbound conversation so a model chosen for Arceus survives reloads and is used by the next unbound execution.

## Scope and non-goals

- Persist `selectedModelId` in the existing server-side conversation metadata.
- Return the persisted value from the existing conversation GET response.
- Accept and save the value through the existing conversation state flow.
- Pass the value into the synthetic unbound workflow run and Codex bridge payload.
- Keep the current model catalog and default fallback behavior for conversations without a saved value.
- Do not change UI structure, labels, CSS, layout, or visual behavior.
- Do not create a synthetic persistent workflow run for an unbound conversation.

## Data flow

1. The dashboard loads the unbound conversation and receives `metadata.selectedModelId`.
2. The existing Codex model selector uses that value when present; otherwise it continues to use the bridge default (`MiniMax-M3`).
3. Selecting a model persists the value against the current conversation ID through a small conversation metadata update request.
4. The next unbound dispatch reads the stored model and creates its synthetic `WorkflowRun` with `selectedModelId`.
5. `invokeConfiguredAgent` forwards `run.selectedModelId` to the Codex bridge, which already maps the model to the matching provider.

## Persistence contract

`ConversationMetadata` gains an optional `selectedModelId?: string`. Existing database rows remain valid through a nullable schema migration. Empty values clear the setting and restore the bridge default.

The setting is scoped to the conversation, not globally to the browser and not to all agents. It is only consumed for `codex`/Arceus execution; Lucky and OpenClaw routing remain unchanged.

## Error handling

- Missing metadata keeps the current default model behavior.
- Invalid or empty model values are not used as an execution override.
- A metadata write failure must leave the current server value unchanged and surface an ordinary API error; it must not alter conversation messages.
- Existing conversation and workflow routes remain backward-compatible when `selectedModelId` is absent.

## Verification

- Repository test: metadata round-trip persists and reads `selectedModelId`.
- API/service test: unbound model update returns the saved value and rejects malformed conversation IDs or model payloads according to existing validation conventions.
- Dispatch test: an unbound Codex invocation receives the persisted model in its synthetic run and bridge payload.
- Regression checks: existing conversation, model-catalog, bridge, typecheck, and production build tests remain green.
