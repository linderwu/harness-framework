import { HarnessDashboard } from "@/components/harness-dashboard"
import { readState } from "@/lib/store"
import { getHiveMemoryHealth } from "@/lib/hive-health"
import { getDefaultHiveServices } from "@/lib/hive-services"

export const dynamic = "force-dynamic"

export default async function Home() {
  const initialState = await readState()
  const initialHiveHealth = await getHiveMemoryHealth(getDefaultHiveServices().database)

  return <HarnessDashboard initialState={initialState} initialHiveHealth={initialHiveHealth} />
}
