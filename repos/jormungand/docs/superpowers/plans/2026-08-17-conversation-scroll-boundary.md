# Conversation Scroll Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent long conversations from expanding the page indefinitely by constraining the conversation panel and making only the message list scroll.

**Architecture:** Keep the existing conversation component and data flow unchanged. Adjust the existing CSS grid sizing so the workspace and conversation panel can shrink, then make `.conversationEntries` the bounded scroll region while keeping the composer visible.

**Tech Stack:** Next.js, React, TypeScript, global CSS, npm build.

---

### Task 1: Constrain the conversation layout

**Files:**
- Modify: `app/globals.css:1749-1832`
- Modify: `app/globals.css:2606-2704`

- [ ] **Step 1: Make the workspace and panel shrinkable**

  Add `min-height: 0` to `.conversationWorkspace` and change the desktop `.taskConversation` grid row to `minmax(0, 1fr)` so its message area can consume only the available height.

- [ ] **Step 2: Make the message list the scroll container**

  Add `min-height: 0` and `overscroll-behavior: contain` to `.conversationEntries`, preserving its existing vertical overflow behavior.

- [ ] **Step 3: Preserve mobile behavior**

  Add `min-height: 0` to the mobile `.conversationWorkspace` and retain the existing mobile panel height and sticky composer rules.

- [ ] **Step 4: Inspect the resulting diff**

  Run `git diff -- app/globals.css` and verify that only the conversation layout rules changed.

### Task 2: Verify the frontend

**Files:**
- Test: `app/globals.css` via the production build

- [ ] **Step 1: Run the production build**

  Run `npm run build` from the repository root. Expected: exit code 0 and a successful Next.js production build.

- [ ] **Step 2: Check repository state**

  Run `git status --short --branch` and confirm the intended CSS and plan files are present, while pre-existing unrelated changes remain untouched.

### Task 3: Commit and push

**Files:**
- Commit: `app/globals.css` and `docs/superpowers/plans/2026-08-17-conversation-scroll-boundary.md`

- [ ] **Step 1: Commit only the intended files**

  Run `git add app/globals.css docs/superpowers/plans/2026-08-17-conversation-scroll-boundary.md` followed by `git commit -m "fix: constrain conversation scrolling"`.

- [ ] **Step 2: Push main**

  Run `git push origin main`. Expected: the new commit is accepted on `origin/main`.

- [ ] **Step 3: Verify the pushed state**

  Run `git status --short --branch` and `git log -1 --oneline --decorate`; expected: local `main` matches `origin/main` and the commit is the conversation scrolling fix.
