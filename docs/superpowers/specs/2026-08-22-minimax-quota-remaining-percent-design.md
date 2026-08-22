# MiniMax 5-hour quota display design

## Context

The dashboard's MiniMax/Lucky quota bar currently consumes the generic
`AgentQuota.remainingPercent` field, but the Lucky bridge calculates that value
from local agent run duration. MiniMax's account quota response exposes the
authoritative 5-hour value as `current_interval_remaining_percent`.

## Goal

Display the MiniMax 5-hour bar from
`current_interval_remaining_percent`, while leaving Codex quota behavior and
the existing quota-bar component unchanged.

## Design

1. Add the MiniMax interval remaining percentage to the quota data contract at
   the server boundary.
2. Read the official MiniMax quota response and select the chat/model row used
   by the agent. Map `current_interval_remaining_percent` to the existing
   `AgentQuota.remainingPercent` field consumed by the dashboard.
3. Keep the shared MiniMax value for Lucky and the OpenClaw cards because they
   use the same MiniMax account quota.
4. If the official field is missing, malformed, or unavailable, return the
   MiniMax quota as `unavailable` rather than presenting the local seconds
   estimate as an authoritative percentage.
5. Keep Codex quota retrieval and rendering unchanged.

## Non-goals

- No redesign of the quota bar or dashboard layout.
- No change to MiniMax weekly quota presentation.
- No changes to unrelated bridge behavior, run accounting, or local logs.

## Verification

- Unit tests prove a MiniMax response with
  `current_interval_remaining_percent: 42` produces `remainingPercent: 42`.
- Unit tests prove missing/invalid MiniMax quota data produces `unavailable`.
- Existing quota and dashboard structure tests continue to pass.
- The Jormungand TypeScript build passes.

## Risks

MiniMax may return multiple model rows or use a different model name between
regions. The parser must prefer the chat/general row and fail closed when no
authoritative interval percentage can be identified.
