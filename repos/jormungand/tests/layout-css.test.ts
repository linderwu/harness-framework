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

test("desktop layout allows the page to scroll instead of clipping content", () => {
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
  assert.doesNotMatch(ruleBody(/\.shell/, ".shell"), /\n\s*height:\s*100vh;/)
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

test("bridge status panel is embedded in the compose panel", () => {
  const panelRule = ruleBody(/\.bridgeStatusPanel/, ".bridgeStatusPanel")
  const cardsRule = ruleBody(/\.bridgeStatusCards/, ".bridgeStatusCards")

  assert.doesNotMatch(panelRule, /position:\s*fixed;/)
  assert.doesNotMatch(panelRule, /bottom:\s*18px;/)
  assert.doesNotMatch(panelRule, /right:\s*18px;/)
  assert.match(panelRule, /background:\s*rgba\(255, 255, 255, 0\.08\);/)
  assert.match(cardsRule, /grid-template-columns:\s*1fr;/)
  assert.doesNotMatch(css, /\.bridgeStatusToggle/)
  assert.doesNotMatch(css, /\.bridgeStatusCards:not\(\.open\)/)
})

test("global mode navigator spans nine modes and scrolls at narrow widths", () => {
  const navRule = ruleBody(/\.globalModeNav/, ".globalModeNav")
  const selectedRule = ruleBody(/\.globalModeNav button\.selected/, ".globalModeNav selected")

  assert.match(navRule, /grid-template-columns:\s*repeat\(9,/)
  assert.match(navRule, /width:\s*100%;/)
  assert.match(selectedRule, /aria-current|transform|box-shadow/)
  assert.doesNotMatch(css, /\.modeEdgeButton/)
  assert.match(
    css,
    /@media \(max-width: 980px\)[\s\S]*?\.globalModeNav\s*\{[\s\S]*?grid-auto-flow:\s*column;[\s\S]*?overflow-x:\s*auto;/
  )
})

test("task workspace makes conversation the largest responsive column", () => {
  const rule = ruleBody(/\.taskWorkspaceGrid/, ".taskWorkspaceGrid")
  assert.match(rule, /minmax\(240px, 0\.72fr\) minmax\(520px, 2fr\) minmax\(260px, 0\.8fr\)/)
  assert.match(ruleBody(/\.taskConversation/, ".taskConversation"), /min-height:\s*70vh/)
  const tablet = css.slice(css.indexOf("@media (max-width: 980px)"))
  assert.match(tablet, /\.conversationWorkspace\s*\{[\s\S]*?order:\s*-1/)
  assert.match(tablet, /\.taskNavigation[\s\S]*?details|\.taskStatusSidebar[\s\S]*?details/)
})
