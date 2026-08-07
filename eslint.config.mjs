import nextVitals from "eslint-config-next/core-web-vitals"
import nextTypescript from "eslint-config-next/typescript"

const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".tmp-tests/**",
      ".tmp-tests*/**",
      ".worktrees/**",
      "worktrees/**",
      ".agents/**",
      "data/harness-state.json"
    ]
  },
  ...nextVitals,
  ...nextTypescript
]

export default eslintConfig
