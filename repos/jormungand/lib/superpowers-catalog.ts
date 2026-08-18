import { execFile } from "child_process"
import { existsSync } from "fs"
import { mkdir, readdir, readFile } from "fs/promises"
import path from "path"
import { promisify } from "util"

const execFileAsync = promisify(execFile)
const refreshIntervalMs = 6 * 60 * 60 * 1000
const repositoryUrl =
  process.env.JORMUNGAND_SKILL_REPOSITORY_URL ??
  "https://github.com/linderwu/jormungand_skill.git"
const repositoryDir = path.join(process.cwd(), ".harness", "superpowers-catalog")

export interface SuperpowersSkill {
  id: string
  name: string
  content: string
  commitSha: string
}

interface CatalogCache {
  refreshedAt: number
  skills: SuperpowersSkill[]
}

let cache: CatalogCache | undefined
let refreshPromise: Promise<CatalogCache> | undefined

export async function getSuperpowersCatalog() {
  if (cache && Date.now() - cache.refreshedAt < refreshIntervalMs) {
    return cache
  }

  if (!refreshPromise) {
    refreshPromise = refreshCatalog().finally(() => {
      refreshPromise = undefined
    })
  }

  try {
    return await refreshPromise
  } catch (error) {
    if (cache) return cache
    throw error
  }
}

async function refreshCatalog(): Promise<CatalogCache> {
  await mkdir(path.dirname(repositoryDir), { recursive: true })

  if (existsSync(path.join(repositoryDir, ".git"))) {
    await execFileAsync("git", ["-C", repositoryDir, "fetch", "--depth", "1", "origin", "main"])
    await execFileAsync("git", ["-C", repositoryDir, "reset", "--hard", "FETCH_HEAD"])
  } else {
    await execFileAsync("git", ["clone", "--depth", "1", repositoryUrl, repositoryDir])
  }

  const { stdout } = await execFileAsync("git", ["-C", repositoryDir, "rev-parse", "HEAD"])
  const commitSha = stdout.trim()
  const skillsDir = path.join(repositoryDir, "skills", "superpowers")
  const entries = await readdir(skillsDir, { withFileTypes: true })
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillPath = path.join(skillsDir, entry.name, "SKILL.md")
        if (!existsSync(skillPath)) return undefined
        return {
          id: entry.name,
          name: entry.name.replaceAll("-", " "),
          content: await readFile(skillPath, "utf8"),
          commitSha
        } satisfies SuperpowersSkill
      })
  )

  cache = {
    refreshedAt: Date.now(),
    skills: skills.filter((skill): skill is SuperpowersSkill => Boolean(skill))
  }
  return cache
}
