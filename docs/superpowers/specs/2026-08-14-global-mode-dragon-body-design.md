# Global Mode Dragon Body Design

## Goal

Turn the seven Global mode choices into one continuous, segmented dragon body while preserving the existing project-type behavior, iconography, labels, keyboard use, and responsive compose-panel layout.

## Approved direction

Use the selected **A · Armor Spine / 鱗甲脊骨** direction. Each mode button is a beveled armor segment with pointed interlocking ends. The first segment has a broader dragon-head silhouette and a small glowing eye; the last segment tapers into a tail. A faint cyan spine joins the seven choices behind the buttons.

## Visual states

- Resting segments use the existing navy glass palette with a brighter upper ridge and dark lower edge.
- The selected segment rises slightly, receives a cyan outline/glow, and remains visually connected to its neighbors.
- Hover and keyboard focus strengthen the ridge and reveal the existing text tooltip.
- Mode-specific page background accents remain unchanged so the dragon control still belongs to the current dashboard theme.

## Interaction and accessibility

- Keep each option as a native `button` with the existing `aria-label` and `aria-pressed` attributes.
- Keep the current click handler and the fixed previous/next edge controls unchanged.
- Decorative spine, eye, ridge, and tail details are CSS-only and expose no redundant content to assistive technology.
- Preserve visible `:focus-visible` treatment and do not encode selection by color alone; the selected segment also changes elevation and scale.

## Responsive behavior

- Keep all seven segments in one horizontal body.
- Below 640 px, give the dock a seven-segment minimum width and allow horizontal scrolling instead of wrapping the dragon into separate rows.
- Maintain a minimum 44 px touch target for every option.

## Scope

- Modify `repos/jormungand/app/globals.css` for the dragon body styling and mobile overflow behavior.
- Extend `repos/jormungand/tests/layout-css.test.ts` with a structural CSS regression test.
- Do not change project types, form state, workflow logic, dependencies, or public component APIs.

## Verification

- Prove the new CSS contract with a red-green regression test.
- Run the full test suite, lint, typecheck, and production build.
- Capture the rendered dashboard and compare it with the approved Armor Spine reference; require a visual-verdict score of at least 90.

