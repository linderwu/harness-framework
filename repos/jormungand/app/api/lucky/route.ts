import { NextResponse } from "next/server"

/**
 * /api/lucky — bare-URL entry point. Returns a short status payload
 * describing where Lucky's bridge lives. The full bridge API surface
 * lives at /api/lucky/<path> (the catch-all sibling in this directory).
 */

export async function GET() {
  const serverBase =
    process.env.LUCKY_BRIDGE_URL ?? "http://127.0.0.1:4198"
  return NextResponse.json({
    ok: true,
    agent: "mavis",
    label: "Lucky",
    bridge: {
      server: serverBase,
      proxy: "see /api/lucky/<path> for the full bridge API"
    },
    tools: [
      "read_file",
      "write_file",
      "edit_file",
      "list_dir",
      "run_command",
      "search_files"
    ],
    docs:
      "POST /api/lucky/agent-runs with the harness-agent-bridge/v0.3 payload."
  })
}
