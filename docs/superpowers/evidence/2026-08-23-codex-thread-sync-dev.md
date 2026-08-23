# Harness ↔ Codex native thread sync — dev evidence

Date: 2026-08-23 (Asia/Taipei)

## Scope

- Branch: `dev`
- Latest commit: `ac74c5c fix: coalesce raced Codex response projections`
- Deployment: Zeabur service `harness-framework-dev`, latest deployment `fix: coalesce raced Codex response projections`, observed `運作中`.
- Verification URL: https://harness-framework-dev.zeabur.app/
- Zeabur service page: https://zeabur.com/projects/6a8963769c1441c21a54a97e/services/6a8964979c1441c21a54a9d8?envID=6a896376cac6c1b35ed69ed0
- The local dev Codex Bridge was restarted on `127.0.0.1:4299` from this dev worktree. The main Bridge on port `4177` was not changed.

## Automated checks

- `npm run typecheck`: pass.
- `npm run build`: pass; Next.js generated all 14 static pages successfully.
- `npm run lint`: pass with 0 errors and 13 pre-existing warnings.
- Codex-focused compiled test set: 41 passed, 0 failed.
- The repository `npm test` script remains incompatible with this Windows shell because its quoted `node --test ".tmp-tests/tests/**/*.test.js"` glob is passed literally. The equivalent explicit compiled test invocation was used for the focused result above. The broader suite has unrelated baseline failures recorded during verification (legacy agent-profile expectation, old schema fixtures, layout assertions, and OpenClaw startup timeouts).

## Browser and Codex observations

1. Before the final coalescing fix, a fresh deployed Harness smoke reached `Codex sync: Synced`, completed a Codex turn, and exposed a real race: one Harness user plus two identical agent replies. This led directly to `ac74c5c`, which coalesces same-turn native agent projections onto the Harness response placeholder and repoints the sync ledger.
2. Zeabur subsequently showed the `ac74c5c` deployment as running, with Next.js runtime logs reporting `Ready`.
3. The Codex app sidebar listed the generated native task as `Harness · New conversation`, with cwd `C:\Users\linder\Documents\harness-framework-dev\repos\jormungand`. Reading that native task returned one completed turn containing the Harness user transcript and the Codex final reply.
4. A native Codex-originated test message completed with `SYNC_NATIVE_OK` after temporarily stopping only the dev Bridge. When the Bridge was restarted, `thread/resume` for that same thread returned Codex App Server error `thread ... already has an active writer`; Harness correctly exposed `Codex sync: Waiting for sync` rather than replacing the durable mapping.
5. A post-restart Harness-originated smoke on a new conversation reached `Codex sync: Synced` and completed successfully. The duplicate response observed in that pre-`ac74c5c` smoke is the regression covered by the new coalescing test.
6. The final browser extension tab became unavailable while waiting for the latest post-deploy DOM snapshot, so no stronger claim is made about a post-`ac74c5c` live message count than the automated regression evidence above.

## Residual risk

Codex App Server enforces a single active writer for a native thread. If Codex desktop currently owns the writer, Bridge resume can temporarily fail and Harness remains in waiting/offline state with the same durable thread mapping. The implementation preserves the mapping and retries; it does not create a replacement for this temporary writer conflict. A future acceptance pass should repeat the native-side message test after the desktop writer is released and confirm import within 30 seconds.

No production/main deployment, admin elevation, UAC change, or unrelated service/resource mutation was performed.
