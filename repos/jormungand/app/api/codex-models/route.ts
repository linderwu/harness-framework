import { NextResponse } from "next/server"

const modelsTimeoutMs = 5000

export async function GET() {
  const bridgeUrl = process.env.CODEX_BRIDGE_URL ?? "http://127.0.0.1:4177"
  const headers: HeadersInit = {}
  const bridgeToken = process.env.CODEX_BRIDGE_TOKEN?.trim()

  if (bridgeToken) {
    headers.Authorization = `Bearer ${bridgeToken}`
  }

  try {
    const response = await fetch(new URL("models", normalizeUrl(bridgeUrl)), {
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(modelsTimeoutMs)
    })
    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      return NextResponse.json(
        { error: data.error ?? `Codex bridge returned ${response.status}` },
        { status: response.status }
      )
    }

    return NextResponse.json(data)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503 }
    )
  }
}

function normalizeUrl(value: string) {
  const trimmed = value.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  return withScheme.endsWith("/") ? withScheme : `${withScheme}/`
}
