# Task 7 Layered Press Evidence

Date: 2026-08-18

## Scope

- `app/globals.css`
- `tests/layout-css.test.ts`
- `tests/conversation-ui-structure.test.ts`

## RED

Commands:

```text
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/layout-css.test.js .tmp-tests/tests/conversation-ui-structure.test.js
```

Observed result before implementation:

- `npx tsc -p tsconfig.tests.json` passed.
- Targeted tests failed `2` of `18`.
- Failing checks:
  - `conversation buttons use short layered press depth with focus, disabled, and motion-safe states`
  - `conversation manager layout wraps without fixed widths and preserves narrow-screen overflow safety`

These failures matched the missing Task 7 CSS contract: no layered press depth rule for the conversation buttons, and no wrapping header layout rule for the conversation manager.

## GREEN

Commands:

```text
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/layout-css.test.js .tmp-tests/tests/conversation-ui-structure.test.js
```

Observed result after implementation:

- `npx tsc -p tsconfig.tests.json` passed.
- Targeted tests passed `18` of `18`.

## Full Verification

Commands:

```text
npm test
npm run typecheck
```

Observed result:

- `npm test` passed `210` of `210`.
- `npm run typecheck` passed.

## Notes

- The change stayed CSS-only for application behavior, as requested.
- The conversation header/action layout contract is reinforced by source-structure assertions without modifying `components/task-conversation.tsx`.
