export function normalizeCodexModels(result) {
  const entries = Array.isArray(result?.data) ? result.data : []
  const models = []
  const seen = new Set()

  for (const entry of entries) {
    const id = String(entry?.model ?? entry?.id ?? "").trim()
    if (!id || entry?.hidden === true || seen.has(id)) continue

    seen.add(id)
    models.push({
      id,
      displayName: String(entry?.displayName ?? id).trim() || id,
      description: String(entry?.description ?? "").trim() || undefined,
      defaultReasoningEffort: String(entry?.defaultReasoningEffort ?? "").trim() || undefined,
      supportedReasoningEfforts: Array.isArray(entry?.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts
            .map((effort) => String(effort?.reasoningEffort ?? "").trim())
            .filter(Boolean)
        : [],
      isDefault: entry?.isDefault === true
    })
  }

  return models
}

export function defaultCodexModelId(models) {
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id
}

export function buildCodexExecModelArgs(modelId, reasoningIntensity) {
  const args = []
  const normalizedModelId = String(modelId ?? "").trim()
  const normalizedReasoningIntensity = String(reasoningIntensity ?? "").trim()

  if (normalizedModelId && normalizedModelId !== "ChatGPT OAuth") {
    args.push("--model", normalizedModelId)
  }

  if (["low", "medium", "high"].includes(normalizedReasoningIntensity)) {
    args.push("-c", `model_reasoning_effort="${normalizedReasoningIntensity}"`)
  }

  return args
}
