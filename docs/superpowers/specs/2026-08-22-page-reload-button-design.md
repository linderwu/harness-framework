# Full-page reload button

## Goal

Let the dashboard operator reload the complete browser page from the existing
topbar refresh control.

## Design

- Keep the existing topbar refresh button and its icon.
- Change its action to `window.location.reload()`.
- Add an explicit accessible label and title: `Reload page`.
- Leave the bridge-health refresh control as a local data refresh.

## Verification

- Add a dashboard structure test for the topbar action and accessible label.
- Run the focused test, then `npm run typecheck` and `npm run build`.
