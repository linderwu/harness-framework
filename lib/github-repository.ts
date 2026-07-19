import { spawn } from "child_process"

interface GitHubRepositoryRef {
  owner?: string
  name: string
}

interface GitHubApiRepository {
  full_name?: string
  name?: string
  owner?: {
    login?: string
  }
}

export class GitHubRepositoryError extends Error {
  status: number

  constructor(message: string, status = 502) {
    super(message)
    this.name = "GitHubRepositoryError"
    this.status = status
  }
}

export async function ensureGitHubRepository(repository: string) {
  const repo = parseRepositoryRef(repository)

  if (!repo) {
    return ""
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN

  if (token) {
    return ensureRepositoryWithApi(repo, token)
  }

  return ensureRepositoryWithCli(repo)
}

function parseRepositoryRef(value: string): GitHubRepositoryRef | undefined {
  const normalized = normalizeRepositoryInput(value)

  if (!normalized) {
    return undefined
  }

  const parts = normalized.split("/")

  if (parts.length === 1) {
    assertValidRepositorySegment(parts[0], "repository name")
    return { name: parts[0] }
  }

  if (parts.length === 2) {
    assertValidRepositorySegment(parts[0], "repository owner")
    assertValidRepositorySegment(parts[1], "repository name")
    return { owner: parts[0], name: parts[1] }
  }

  throw new GitHubRepositoryError(
    "Repository must be a GitHub repo name, owner/name, or GitHub URL.",
    400
  )
}

function normalizeRepositoryInput(value: string) {
  let normalized = value.trim()

  if (!normalized) {
    return ""
  }

  normalized = normalized.replace(/^git@github\.com:/i, "")
  normalized = normalized.replace(/^https?:\/\/github\.com\//i, "")
  normalized = normalized.replace(/\.git$/i, "")
  normalized = normalized.replace(/^\/+|\/+$/g, "")

  return normalized
}

function assertValidRepositorySegment(value: string, label: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new GitHubRepositoryError(`Invalid GitHub ${label}: ${value}`, 400)
  }
}

async function ensureRepositoryWithApi(
  repo: GitHubRepositoryRef,
  token: string
) {
  const viewer = await fetchGitHubViewer(token)
  const owner = repo.owner ?? viewer
  const existing = await fetchGitHubRepository(owner, repo.name, token)

  if (existing) {
    return formatRepositoryFullName(existing)
  }

  const created =
    owner.toLowerCase() === viewer.toLowerCase()
      ? await createUserRepository(repo.name, token)
      : await createOrganizationRepository(owner, repo.name, token)

  return formatRepositoryFullName(created)
}

async function fetchGitHubViewer(token: string) {
  const response = await githubFetch("https://api.github.com/user", token)

  if (!response.ok) {
    throw new GitHubRepositoryError(
      `GitHub authentication failed with HTTP ${response.status}. Set GITHUB_TOKEN or GH_TOKEN for the account that should create repositories.`,
      response.status === 401 || response.status === 403 ? 401 : 502
    )
  }

  const data = (await response.json()) as { login?: string }

  if (!data.login) {
    throw new GitHubRepositoryError("GitHub did not return the current user.", 502)
  }

  return data.login
}

async function fetchGitHubRepository(
  owner: string,
  name: string,
  token: string
) {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${name}`,
    token
  )

  if (response.status === 404) {
    return undefined
  }

  if (!response.ok) {
    throw new GitHubRepositoryError(
      `Could not check GitHub repository ${owner}/${name}: HTTP ${response.status}.`,
      response.status
    )
  }

  return (await response.json()) as GitHubApiRepository
}

async function createUserRepository(name: string, token: string) {
  const response = await githubFetch("https://api.github.com/user/repos", token, {
    method: "POST",
    body: JSON.stringify(createRepositoryPayload(name))
  })

  return readCreatedRepository(response, name)
}

async function createOrganizationRepository(
  owner: string,
  name: string,
  token: string
) {
  const response = await githubFetch(
    `https://api.github.com/orgs/${owner}/repos`,
    token,
    {
      method: "POST",
      body: JSON.stringify(createRepositoryPayload(name))
    }
  )

  return readCreatedRepository(response, `${owner}/${name}`)
}

function createRepositoryPayload(name: string) {
  return {
    name,
    private: process.env.GITHUB_REPOSITORY_VISIBILITY !== "public",
    auto_init: false
  }
}

async function readCreatedRepository(response: Response, label: string) {
  if (!response.ok) {
    const details = await response.text().catch(() => "")
    throw new GitHubRepositoryError(
      `Could not create GitHub repository ${label}: HTTP ${response.status}${details ? ` ${details}` : ""}`,
      response.status
    )
  }

  return (await response.json()) as GitHubApiRepository
}

function githubFetch(url: string, token: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers
    }
  })
}

function formatRepositoryFullName(repo: GitHubApiRepository) {
  if (repo.full_name) {
    return repo.full_name
  }

  if (repo.owner?.login && repo.name) {
    return `${repo.owner.login}/${repo.name}`
  }

  throw new GitHubRepositoryError("GitHub did not return a repository name.", 502)
}

async function ensureRepositoryWithCli(repo: GitHubRepositoryRef) {
  const viewer = repo.owner ? undefined : await runGh(["api", "user", "--jq", ".login"])
  const fullName = repo.owner ? `${repo.owner}/${repo.name}` : `${viewer}/${repo.name}`
  const viewResult = await runCommand("gh", [
    "repo",
    "view",
    fullName,
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner"
  ])

  if (viewResult.exitCode === 0 && viewResult.stdout.trim()) {
    return viewResult.stdout.trim()
  }

  const visibility =
    process.env.GITHUB_REPOSITORY_VISIBILITY === "public" ? "--public" : "--private"
  await runGh(["repo", "create", fullName, visibility])
  return fullName
}

async function runGh(args: string[]) {
  const result = await runCommand("gh", args)

  if (result.exitCode === 0) {
    return result.stdout.trim()
  }

  throw new GitHubRepositoryError(
    `GitHub CLI failed: ${result.stderr.trim() || result.stdout.trim() || `gh ${args.join(" ")}`}. Authenticate with gh auth login or set GITHUB_TOKEN/GH_TOKEN.`,
    502
  )
}

function runCommand(command: string, args: string[]) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true
      })
      let stdout = ""
      let stderr = ""

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString()
      })
      child.on("error", (error) => {
        reject(
          new GitHubRepositoryError(
            `${command} is not available. Install GitHub CLI or set GITHUB_TOKEN/GH_TOKEN: ${error.message}`,
            502
          )
        )
      })
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr })
      })
    }
  )
}
