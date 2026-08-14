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

test("global mode dock forms one continuous armor-spine dragon body", () => {
  const dockRule = ruleBody(/\.modeDock/, ".modeDock")
  const spineRule = ruleBody(/\.modeDock::before/, ".modeDock::before")
  const segmentRule = ruleBody(/\.modeDock button/, ".modeDock button")
  const headRule = ruleBody(
    /\.modeDock button:first-child/,
    ".modeDock dragon head"
  )
  const tailRule = ruleBody(
    /\.modeDock button:last-child/,
    ".modeDock dragon tail"
  )
  const selectedRule = ruleBody(
    /\.modeDock button\.selected/,
    ".modeDock selected segment"
  )

  assert.match(dockRule, /grid-template-columns:\s*repeat\(7,/)
  assert.match(dockRule, /isolation:\s*isolate;/)
  assert.match(spineRule, /linear-gradient/)
  assert.match(segmentRule, /clip-path:\s*polygon/)
  assert.match(headRule, /clip-path:\s*polygon/)
  assert.match(tailRule, /clip-path:\s*polygon/)
  assert.match(selectedRule, /z-index:\s*3;/)
  assert.match(selectedRule, /translateY\(-4px\)/)
  assert.match(
    css,
    /@media \(max-width: 640px\)[\s\S]*?\.modeDock\s*\{[\s\S]*?grid-template-columns:\s*repeat\(7,[\s\S]*?overflow-x:\s*auto;/
  )
})
