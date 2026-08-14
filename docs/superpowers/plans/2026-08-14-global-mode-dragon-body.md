# Global Mode Dragon Body Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the seven Global mode buttons as one accessible, responsive Armor Spine dragon body.

**Architecture:** Retain the existing React buttons and state flow, and implement the approved look entirely in the Global mode CSS. A source-level CSS contract test locks the head, body, tail, selected state, and narrow-screen single-row behavior without coupling workflow logic to presentation.

**Tech Stack:** Next.js 16, React 18, TypeScript, CSS, Node test runner

---

### Task 1: Lock the dragon-body CSS contract

**Files:**
- Modify: `repos/jormungand/tests/layout-css.test.ts`
- Test: `repos/jormungand/tests/layout-css.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that reads `app/globals.css` and asserts the presence of `.modeDock::before`, armor-segment `clip-path`, `.modeDock button:first-child`, `.modeDock button:last-child`, selected elevation, and the 640 px seven-column overflow rule.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="dragon body"`

Expected: FAIL because the dragon spine, head, tail, and mobile continuity selectors do not exist yet.

- [ ] **Step 3: Commit the red test together with the eventual implementation**

The repository test script compiles all tests as one suite, so keep the failing test unstaged until Task 2 turns it green.

### Task 2: Implement the Armor Spine styling

**Files:**
- Modify: `repos/jormungand/app/globals.css`
- Test: `repos/jormungand/tests/layout-css.test.ts`

- [ ] **Step 1: Replace the current rectangular dock presentation**

Give `.modeDock` a transparent layered chamber, a cyan `.modeDock::before` spine, seven equal columns, isolation, and padding around the silhouette.

- [ ] **Step 2: Shape the body, head, and tail**

Use a six-point polygon for every `.modeDock button`, a broader first-child polygon with a glowing eye, and a tapered last-child polygon. Keep each native button at least 56 px tall and retain the existing icon and tooltip content.

- [ ] **Step 3: Preserve legible interaction states**

Keep hover and selected backgrounds distinct. Raise and scale the selected segment, lift it above adjacent segments with `z-index`, and retain a clear `:focus-visible` outline.

- [ ] **Step 4: Preserve the continuous body on narrow screens**

At 980 px retain seven columns. At 640 px set a seven-segment minimum width and horizontal overflow instead of changing the dock to two or four columns; keep 44 px minimum touch targets.

- [ ] **Step 5: Run the red test to verify it passes**

Run: `npm test -- --test-name-pattern="dragon body"`

Expected: PASS, including the new dragon-body CSS contract.

### Task 3: Verify and publish

**Files:**
- Verify: `repos/jormungand/app/globals.css`
- Verify: `repos/jormungand/tests/layout-css.test.ts`

- [ ] **Step 1: Run automated validation**

Run from `repos/jormungand`: `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`.

Expected: all commands exit 0 with no test failures, lint errors, type errors, or build errors.

- [ ] **Step 2: Run visual validation**

Launch the dashboard, capture the Global mode control at desktop and narrow widths, and compare the desktop result to the approved Armor Spine reference. Persist a visual-verdict JSON score of at least 90 in `.omx/state/global-mode-dragon-body/ralph-progress.json`.

- [ ] **Step 3: Commit the implementation**

Stage only the CSS and its regression test. Use a Lore-format commit describing why Global mode now reads as Jormungand's segmented body and listing the validation evidence.

- [ ] **Step 4: Push main**

Run: `git push origin main`

Expected: the local `main` commit is accepted by `origin/main`.

