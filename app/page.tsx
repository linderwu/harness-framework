import { HarnessDashboard } from "@/components/harness-dashboard"
import { listWorkflowRuns } from "@/lib/store"

export const dynamic = "force-dynamic"

export default async function Home() {
  const initialRuns = await listWorkflowRuns()

  return <HarnessDashboard initialRuns={initialRuns} />
}
