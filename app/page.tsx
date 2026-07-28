import { HarnessDashboard } from "@/components/harness-dashboard"
import { readState } from "@/lib/store"

export const dynamic = "force-dynamic"

export default async function Home() {
  const initialState = await readState()

  return <HarnessDashboard initialState={initialState} />
}
