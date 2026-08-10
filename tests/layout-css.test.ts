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
