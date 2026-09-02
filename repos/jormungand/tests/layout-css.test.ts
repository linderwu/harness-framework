import { readFileSync } from "node:fs"
import { test } from "node:test"
import { strict as assert } from "node:assert"

const css = readFileSync("app/globals.css", "utf8")

function ruleBody(selectorPattern: RegExp, description: string) {
  const match = css.match(
    new RegExp(`${selectorPattern.source}\\s*\\{([\\s\\S]*?)\\n\\}`)
  )

  assert.ok(match, `Expected ${description} rule to exist`)

  return match[1]
}

function mediaBlock(queryPattern: RegExp, description: string) {
  const match = css.match(new RegExp(`@media\\s*${queryPattern.source}\\s*\\{`))

  assert.ok(match?.index !== undefined, `Expected ${description} media block to exist`)

  const start = match.index
  const nextMedia = css.indexOf("\n@media ", start + 1)

  return css.slice(start, nextMedia === -1 ? undefined : nextMedia)
}

test("desktop layout keeps the workspace within the viewport while allowing page scrolling", () => {
  const rootRule = css.match(/html,\s*\nbody\s*\{([\s\S]*?)\n\}/)

  assert.ok(rootRule, "Expected html/body rule to exist")
  assert.match(rootRule[1], /overflow:\s*auto;/)
  assert.doesNotMatch(rootRule[1], /overflow:\s*hidden;/)

  for (const [selectorPattern, description] of [
    [/\.shell/, ".shell"],
    [/\.layoutGrid/, ".layoutGrid"],
    [/\.workspace,\s*\n\.detailStack/, ".workspace/.detailStack"]
  ] as const) {
    assert.doesNotMatch(ruleBody(selectorPattern, description), /overflow:\s*hidden;/)
  }

  assert.match(ruleBody(/\.shell/, ".shell"), /min-height:\s*100vh;/)
  assert.match(ruleBody(/\.shell/, ".shell"), /\n\s*height:\s*100vh;/)
})

test("project hero action buttons keep stable visible dimensions", () => {
  const actionRule = ruleBody(
    /\.projectActionStack\s+\.primaryButton,\s*\n\.projectActionStack\s+\.iconTextButton/,
    "project hero action buttons"
  )

  assert.match(actionRule, /min-height:\s*44px;/)
  assert.match(actionRule, /min-width:\s*96px;/)
})

test("project selector keeps the workspace header stable and overlays its popover", () => {
  const selectorRule = ruleBody(/\.projectSelector/, ".projectSelector")
  const summaryRule = ruleBody(
    /\.projectSelectorSummary/,
    ".projectSelectorSummary"
  )
  const popoverRule = ruleBody(
    /\.projectSelectorPopover/,
    ".projectSelectorPopover"
  )

  assert.match(selectorRule, /position:\s*relative;/)
  assert.match(summaryRule, /min-height:\s*100%;/)
  assert.match(popoverRule, /position:\s*absolute;/)
  assert.match(popoverRule, /z-index:\s*10;/)
})

test("bridge status panel expands in the monitoring rail without nested scrolling", () => {
  const panelRule = ruleBody(/\.bridgeStatusPanel/, ".bridgeStatusPanel")
  const cardsRule = ruleBody(/\.bridgeStatusCards/, ".bridgeStatusCards")

  assert.doesNotMatch(panelRule, /position:\s*fixed;/)
  assert.doesNotMatch(panelRule, /bottom:\s*18px;/)
  assert.doesNotMatch(panelRule, /right:\s*18px;/)
  assert.doesNotMatch(panelRule, /overflow(?:-y)?:\s*(?:auto|scroll);/)
  assert.match(cardsRule, /grid-template-columns:\s*1fr;/)
  assert.doesNotMatch(cardsRule, /overflow(?:-y)?:\s*(?:auto|scroll);/)
})

test("bridge row layout supports a nested quota bar", () => {
  const rowRule = ruleBody(/\.bridgeAgentRow/, "bridgeAgentRow")
  const rowMainRule = ruleBody(/\.bridgeAgentRowMain/, "bridgeAgentRowMain")
  const trackRule = ruleBody(/\.agentQuotaTrack/, "agentQuotaTrack")

  assert.match(rowRule, /display:\s*grid;/)
  assert.match(rowMainRule, /display:\s*flex;/)
  assert.match(rowMainRule, /justify-content:\s*space-between;/)
  assert.match(trackRule, /overflow:\s*hidden;/)
  assert.match(trackRule, /border-radius:\s*999px;/)
})

test("global mode navigator spans ten modes and scrolls at narrow widths", () => {
  const navRule = ruleBody(/\.globalModeNav/, ".globalModeNav")
  const segmentsRule = ruleBody(/\.globalModeSegments/, ".globalModeSegments")
  const segmentRule = ruleBody(/\.globalModeSegment/, ".globalModeSegment")
  const selectedRule = ruleBody(/\.globalModeSegment\.selected/, ".globalModeNav selected")

  assert.match(navRule, /width:\s*100%;/)
  assert.match(segmentsRule, /grid-template-columns:\s*repeat\(10,/)
  assert.match(segmentRule, /clip-path:\s*polygon\(/)
  assert.match(segmentRule, /filter:\s*drop-shadow\(/)
  assert.match(segmentRule, /background:\s*linear-gradient\(/)
  assert.match(selectedRule, /aria-current|transform|box-shadow/)
  assert.doesNotMatch(css, /\.globalModeSegments::before/)
  assert.doesNotMatch(css, /\.modeEdgeButton/)
  assert.match(
    css,
    /@media \(max-width: 980px\)[\s\S]*?\.globalModeSegments\s*\{[\s\S]*?grid-auto-flow:\s*column;[\s\S]*?overflow-x:\s*auto;/
  )
})

test("new rail controls and role cards retain tactile button depth", () => {
  const railRule = ruleBody(/\.railToggle/, ".railToggle")
  const roleCardRule = ruleBody(/\.agentRoleStatusCard/, ".agentRoleStatusCard")

  assert.match(railRule, /box-shadow:\s*inset/)
  assert.match(railRule, /transform:\s*translateY/)
  assert.match(roleCardRule, /linear-gradient\(/)
  assert.match(roleCardRule, /box-shadow:\s*inset/)
})

test("task workspace makes conversation the largest responsive column", () => {
  const rule = ruleBody(/\.taskWorkspaceGrid/, ".taskWorkspaceGrid")
  assert.match(rule, /minmax\(240px, 0\.72fr\) minmax\(520px, 2fr\) minmax\(260px, 0\.8fr\)/)
  assert.match(css, /\.taskWorkspaceGrid\[data-left-collapsed="true"\]/)
  assert.doesNotMatch(css, /\.taskWorkspaceGrid\[data-right-collapsed=/)
  assert.match(css, /\.taskMonitoringPanel/)
  assert.match(css, /\.bridgeConnectionsPanel/)
  assert.match(ruleBody(/\.taskStatusSidebar/, ".taskStatusSidebar"), /display:\s*grid;/)
  assert.match(ruleBody(/\.taskConversation/, ".taskConversation"), /min-height:\s*70vh/)
  const tablet = css.slice(css.indexOf("@media (max-width: 980px)"))
  assert.match(tablet, /\.conversationWorkspace\s*\{[\s\S]*?order:\s*-1/)
  assert.match(tablet, /\.taskWorkspaceGrid\[data-left-collapsed="true"\]/)
  assert.match(tablet, /grid-template-columns:\s*1fr/)
})

test("Codex activity stays in the left navigation footer", () => {
  const mountRule = ruleBody(/\.taskNavigation\s+\.liveActivityMount/, ".taskNavigation .liveActivityMount")
  const activityRule = ruleBody(/\.codexActivity/, ".codexActivity")

  assert.match(mountRule, /display:\s*grid;/)
  assert.match(mountRule, /margin-top:\s*auto;/)
  assert.match(mountRule, /min-width:\s*0;/)
  assert.match(activityRule, /position:\s*static;/)
  assert.match(activityRule, /width:\s*auto;/)
  assert.match(activityRule, /max-height:\s*min\(32vh,\s*280px\);/)
  assert.match(activityRule, /overflow:\s*hidden;/)
  assert.match(css, /\.taskNavigation\s+\.codexActivityPanel\s*\{\s*width:\s*100%;\s*\}/)
})

test("conversation and live activity buttons use short layered press depth", () => {
  const rootRule = ruleBody(/:root/, ":root")
  const sharedConversationRule = ruleBody(
    /\.taskConversation\s+\.primaryButton,\s*\n\.taskConversation\s+\.dangerButton,\s*\n\.taskConversation\s+\.compactPanelButton,\s*\n\.codexActivity\s+\.compactPanelButton/,
    "conversation-scoped button depth rule"
  )
  const primaryRule = ruleBody(/\.taskConversation\s+\.primaryButton/, ".taskConversation .primaryButton")
  const compactRule = ruleBody(
    /\.taskConversation\s+\.compactPanelButton,\s*\n\.codexActivity\s+\.compactPanelButton/,
    ".taskConversation .compactPanelButton"
  )
  const dangerRule = ruleBody(/\.taskConversation\s+\.dangerButton/, ".taskConversation .dangerButton")
  const compactDangerRule = ruleBody(
    /\.taskConversation\s+\.compactPanelButton\.danger,\s*\n\.codexActivity\s+\.compactPanelButton\.danger/,
    ".taskConversation .compactPanelButton.danger"
  )
  const activeRule = ruleBody(
    /\.taskConversation\s+\.primaryButton:active,\s*\n\.taskConversation\s+\.dangerButton:active,\s*\n\.taskConversation\s+\.compactPanelButton:active,\s*\n\.codexActivity\s+\.compactPanelButton:active/,
    "conversation active layered press rule"
  )
  const focusRule = ruleBody(
    /\.taskConversation\s+\.primaryButton:focus-visible,\s*\n\.taskConversation\s+\.dangerButton:focus-visible,\s*\n\.taskConversation\s+\.compactPanelButton:focus-visible,\s*\n\.codexActivity\s+\.compactPanelButton:focus-visible/,
    "conversation focus-visible button rule"
  )
  const disabledRule = ruleBody(
    /\.taskConversation\s+\.primaryButton:disabled,\s*\n\.taskConversation\s+\.dangerButton:disabled,\s*\n\.taskConversation\s+\.compactPanelButton:disabled,\s*\n\.codexActivity\s+\.compactPanelButton:disabled/,
    "conversation disabled button rule"
  )
  const reducedMotion = mediaBlock(/\(prefers-reduced-motion: reduce\)/, "reduced motion")

  assert.match(rootRule, /--button-depth:/)
  assert.match(rootRule, /--button-depth-danger:/)
  assert.match(rootRule, /--button-press-offset:/)
  assert.match(sharedConversationRule, /transform:\s*translateY\(0\);/)
  assert.match(sharedConversationRule, /transition:/)
  assert.doesNotMatch(sharedConversationRule, /border-left:/)
  assert.doesNotMatch(sharedConversationRule, /0 14px 34px/)
  assert.match(primaryRule, /box-shadow:\s*0 4px 0 var\(--button-depth\)/)
  assert.match(compactRule, /box-shadow:\s*0 4px 0 var\(--button-depth\)/)
  assert.match(dangerRule, /box-shadow:\s*0 4px 0 var\(--button-depth-danger\)/)
  assert.match(compactDangerRule, /box-shadow:\s*0 4px 0 var\(--button-depth-danger\)/)
  assert.match(activeRule, /box-shadow:\s*0 1px 0/)
  assert.match(activeRule, /transform:\s*translateY\(3px\);/)
  assert.match(focusRule, /outline:\s*2px solid/)
  assert.match(focusRule, /outline-offset:\s*2px;/)
  assert.match(disabledRule, /cursor:\s*not-allowed;/)
  assert.match(disabledRule, /opacity:\s*0\.[0-9]+;/)
  assert.match(disabledRule, /box-shadow:\s*0 1px 0/)
  assert.match(reducedMotion, /\.taskConversation\s+\.primaryButton[\s\S]*?transition:\s*none;/)
  assert.doesNotMatch(css, /\.primaryButton,\s*\n\.stopButton,\s*\n\.dangerButton,\s*\n\.iconTextButton,\s*\n\.iconButton,\s*\n\.compactPanelButton\s*\{/)
  assert.doesNotMatch(css, /\.primaryButton:active,\s*\n\.stopButton:active,\s*\n\.dangerButton:active,\s*\n\.iconTextButton:active,\s*\n\.iconButton:active,\s*\n\.compactPanelButton:active/)
})

test("conversation manager layout wraps without fixed widths and preserves narrow-screen overflow safety", () => {
  const headerRule = ruleBody(/\.taskConversationHeader/, ".taskConversationHeader")
  const actionsRule = ruleBody(/\.taskConversationHeaderActions/, ".taskConversationHeaderActions")
  const composerRule = ruleBody(/\.conversationComposer/, ".conversationComposer")
  const mobileBlock = mediaBlock(/\(max-width: 640px\)/, "mobile conversation layout")

  assert.match(headerRule, /flex-wrap:\s*wrap;/)
  assert.match(headerRule, /gap:\s*12px;/)
  assert.match(actionsRule, /min-width:\s*0;/)
  assert.match(actionsRule, /width:\s*100%;/)
  assert.match(actionsRule, /justify-content:\s*flex-end;/)
  assert.doesNotMatch(actionsRule, /width:\s*(?:9[0-9]|[1-9]\d{2,})px;/)
  assert.match(composerRule, /grid-template-columns:\s*minmax\(120px, 0\.32fr\) minmax\(0, 1fr\) auto;/)
  assert.match(
    mobileBlock,
    /\.taskConversationHeader\s*\{[\s\S]*?align-items:\s*stretch;[\s\S]*?flex-direction:\s*column;/
  )
  assert.match(
    mobileBlock,
    /\.taskConversationHeaderActions\s*\{[\s\S]*?justify-content:\s*flex-start;[\s\S]*?width:\s*100%;/
  )
  assert.match(mobileBlock, /\.conversationComposer\s*\{[\s\S]*?grid-template-columns:\s*1fr;/)
  assert.match(mobileBlock, /overscroll-behavior-x:\s*none;/)
  assert.match(mobileBlock, /\.conversationEntry\s*\{[\s\S]*?max-width:\s*96%;/)
})
