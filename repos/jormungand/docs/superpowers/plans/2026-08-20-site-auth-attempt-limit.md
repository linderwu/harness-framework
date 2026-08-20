# Site Basic Auth Attempt Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a process-local, per-source-IP Basic Auth lockout after five consecutive authentication failures while preserving the existing `401` challenge behavior.

**Architecture:** Add a focused in-memory `SiteAuthAttemptTracker` with a process-level instance. Keep `proxy.ts` responsible for bypasses, IP extraction, credential validation, and responses; it will consult the tracker before validation, clear it after success, and record every other authentication failure.

**Tech Stack:** Next.js 16 proxy, TypeScript, Node.js `node:test`, existing npm test/lint/typecheck/build scripts.

---

## File map

- Create `repos/jormungand/lib/site-auth-attempts.ts`: stateful per-IP failure tracker with a five-attempt threshold.
- Modify `repos/jormungand/proxy.ts`: resolve the source IP, consult the tracker, clear successful attempts, and count all failed Basic Auth requests.
- Create `repos/jormungand/tests/site-auth-attempts.test.ts`: proxy-level behavior tests for lockout, reset, IP isolation, header precedence, and malformed/missing credentials.
- Modify `repos/jormungand/README.md`: document the process-local lockout behavior and restart-only reset.

### Task 1: Write the failing lockout behavior test

**Files:**

- Create: `repos/jormungand/tests/site-auth-attempts.test.ts`
- Read: `repos/jormungand/proxy.ts`

- [ ] **Step 1: Add a request helper and the first behavior test**

Use explicit `x-forwarded-for` values so the test does not share the fallback
bucket with other proxy tests:

```ts
import assert from "node:assert/strict"
import test from "node:test"

import { NextRequest } from "next/server"

import { proxy } from "../proxy"

function restoreEnv(key: string) {
  const previous = process.env[key]
  return () => {
    if (previous === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previous
    }
  }
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function siteRequest(
  ip: string,
  authorization: string | undefined,
  extraHeaders: Record<string, string> = {}
) {
  const headers = new Headers({
    "x-forwarded-for": ip,
    ...extraHeaders
  })

  if (authorization === undefined) {
    headers.delete("authorization")
  } else {
    headers.set("authorization", authorization)
  }

  return proxy(
    new NextRequest("https://jormungand.test/", {
      headers
    })
  )
}

test("locks an IP after five failures even when correct credentials follow", (t) => {
  const restoreMode = restoreEnv("SITE_AUTH_MODE")
  const restoreUser = restoreEnv("SITE_AUTH_USERNAME")
  const restorePassword = restoreEnv("SITE_AUTH_PASSWORD")
  t.after(() => {
    restoreMode()
    restoreUser()
    restorePassword()
  })

  process.env.SITE_AUTH_MODE = "all"
  process.env.SITE_AUTH_USERNAME = "site-user"
  process.env.SITE_AUTH_PASSWORD = "site-password"

  const ip = "198.51.100.41"
  const wrong = basic("site-user", "wrong-password")
  const correct = basic("site-user", "site-password")

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(siteRequest(ip, wrong).status, 401)
  }

  const response = siteRequest(ip, correct)
  assert.equal(response.status, 401)
  assert.equal(
    response.headers.get("www-authenticate"),
    'Basic realm="Jormungandr", charset="UTF-8"'
  )
})
```

- [ ] **Step 2: Run the new test and confirm the expected failure**

Run from `repos/jormungand`:

```bash
npm test
```

Expected: the new test fails because the current proxy accepts the correct
credentials after the five preceding failures and returns `200` instead of
`401`. Existing tests should continue to compile and run.

### Task 2: Implement the minimal tracker and proxy integration

**Files:**

- Create: `repos/jormungand/lib/site-auth-attempts.ts`
- Modify: `repos/jormungand/proxy.ts`

- [ ] **Step 1: Add the smallest tracker that satisfies the failing test**

Create this focused implementation:

```ts
export const MAX_SITE_AUTH_FAILURES = 5

export class SiteAuthAttemptTracker {
  private readonly failuresByIp = new Map<string, number>()

  isLocked(ip: string) {
    return (this.failuresByIp.get(ip) ?? 0) >= MAX_SITE_AUTH_FAILURES
  }

  recordFailure(ip: string) {
    const failures = Math.min(
      (this.failuresByIp.get(ip) ?? 0) + 1,
      MAX_SITE_AUTH_FAILURES
    )
    this.failuresByIp.set(ip, failures)
    return failures >= MAX_SITE_AUTH_FAILURES
  }

  recordSuccess(ip: string) {
    this.failuresByIp.delete(ip)
  }
}

export const siteAuthAttemptTracker = new SiteAuthAttemptTracker()
```

- [ ] **Step 2: Integrate the tracker into `proxy.ts`**

Import `siteAuthAttemptTracker`, then after the existing configuration check:

```ts
const clientIp = getClientIp(request)

if (siteAuthAttemptTracker.isLocked(clientIp)) {
  return authenticationRequired()
}

if (hasValidBasicAuth(request, username, password)) {
  siteAuthAttemptTracker.recordSuccess(clientIp)
  return NextResponse.next()
}

siteAuthAttemptTracker.recordFailure(clientIp)
return authenticationRequired()
```

Extract the current challenge response into `authenticationRequired()` so both
ordinary failures and locked IPs preserve the exact same status and header:

```ts
function authenticationRequired() {
  return new NextResponse("Authentication required.", {
    headers: {
      "WWW-Authenticate": `Basic realm="${authRealm}", charset="UTF-8"`
    },
    status: 401
  })
}
```

Resolve IPs before tracking, using the first forwarded value, then the real-IP
fallback, then `unknown`:

```ts
function getClientIp(request: NextRequest) {
  const forwardedIp = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim()
  if (forwardedIp) {
    return forwardedIp
  }

  return request.headers.get("x-real-ip")?.trim() || "unknown"
}
```

Leave bypass checks and the missing-configuration `503` before this logic. The
existing `hasValidBasicAuth` function remains the credential comparison
implementation, so missing, non-Basic, malformed, and wrong credentials all
reach `recordFailure` without adding a second parser.

- [ ] **Step 3: Run the focused test suite and confirm green**

Run:

```bash
npm test
```

Expected: all tests pass, including the lockout test. The locked request must
remain `401` and must include the existing `WWW-Authenticate` value.

### Task 3: Add the remaining behavior tests before refactoring

**Files:**

- Modify: `repos/jormungand/tests/site-auth-attempts.test.ts`

- [ ] **Step 1: Add complete tests for reset, isolation, malformed input, and IP rules**

First update the helper so it can test both forwarded-IP and real-IP fallback
requests, then add the complete behavior cases below:

```ts
function configureSiteAuth(t: { after(callback: () => void): void }) {
  const keys = [
    "SITE_AUTH_MODE",
    "SITE_AUTH_USERNAME",
    "SITE_AUTH_PASSWORD"
  ]
  const previous = new Map(keys.map((key) => [key, process.env[key]]))

  t.after(() => {
    for (const key of keys) {
      const value = previous.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  process.env.SITE_AUTH_MODE = "all"
  process.env.SITE_AUTH_USERNAME = "site-user"
  process.env.SITE_AUTH_PASSWORD = "site-password"
}

function siteRequest(
  ip: string | undefined,
  authorization: string | undefined,
  extraHeaders: Record<string, string> = {}
) {
  const headers = new Headers(extraHeaders)
  if (ip === undefined) {
    headers.delete("x-forwarded-for")
  } else {
    headers.set("x-forwarded-for", ip)
  }

  if (authorization === undefined) {
    headers.delete("authorization")
  } else {
    headers.set("authorization", authorization)
  }

  return proxy(
    new NextRequest("https://jormungand.test/", {
      headers
    })
  )
}

test("counts missing and malformed authorization headers", (t) => {
  configureSiteAuth(t)
  const ip = "198.51.100.42"
  const correct = basic("site-user", "site-password")
  const failures = [
    undefined,
    "Bearer token",
    "Basic !!!",
    undefined,
    "Basic"
  ]

  for (const authorization of failures) {
    assert.equal(siteRequest(ip, authorization).status, 401)
  }

  assert.equal(siteRequest(ip, correct).status, 401)
})

test("successful authentication clears the consecutive failure count", (t) => {
  configureSiteAuth(t)
  const ip = "198.51.100.43"
  const wrong = basic("site-user", "wrong-password")
  const correct = basic("site-user", "site-password")

  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(siteRequest(ip, wrong).status, 401)
  }
  assert.equal(siteRequest(ip, correct).status, 200)

  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(siteRequest(ip, wrong).status, 401)
  }
  assert.equal(siteRequest(ip, correct).status, 200)
})

test("different IPs have independent failure counts", (t) => {
  configureSiteAuth(t)
  const lockedIp = "198.51.100.44"
  const unaffectedIp = "198.51.100.45"
  const wrong = basic("site-user", "wrong-password")
  const correct = basic("site-user", "site-password")

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(siteRequest(lockedIp, wrong).status, 401)
  }

  assert.equal(siteRequest(lockedIp, correct).status, 401)
  assert.equal(siteRequest(unaffectedIp, correct).status, 200)
})

test("x-forwarded-for takes precedence over x-real-ip", (t) => {
  configureSiteAuth(t)
  const forwardedIp = "198.51.100.46, 10.0.0.1"
  const wrong = basic("site-user", "wrong-password")
  const correct = basic("site-user", "site-password")

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(
      siteRequest(forwardedIp, wrong, { "x-real-ip": "198.51.100.47" }).status,
      401
    )
  }

  assert.equal(
    siteRequest(forwardedIp, correct, { "x-real-ip": "198.51.100.48" }).status,
    401
  )
})

test("x-real-ip is used when x-forwarded-for is absent", (t) => {
  configureSiteAuth(t)
  const realIp = "198.51.100.49"
  const wrong = basic("site-user", "wrong-password")
  const correct = basic("site-user", "site-password")

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(
      siteRequest(undefined, wrong, { "x-real-ip": realIp }).status,
      401
    )
  }

  assert.equal(
    siteRequest(undefined, correct, { "x-real-ip": realIp }).status,
    401
  )
})
```

These tests exercise the tracker through the real proxy boundary, so no mock
credentials or mock request objects are needed.

- [ ] **Step 2: Run all tests and fix only implementation defects**

Run:

```bash
npm test
```

Expected: all lockout, reset, IP isolation, malformed input, bypass, and
existing repository tests pass with no warnings or errors.

### Task 4: Document the deployed behavior

**Files:**

- Modify: `repos/jormungand/README.md` near the existing Authentication section.

- [ ] **Step 1: Add a concise operational note**

Document that site Basic Auth counts every failed protected request per source
IP, locks after five consecutive failures, resets that IP after successful
authentication, and clears all in-memory locks only when the service restarts.
State that no manual unlock endpoint exists and that multi-instance deployments
keep independent process-local counters.

- [ ] **Step 2: Run lint and typecheck**

Run:

```bash
npm run lint
npm run typecheck
```

Expected: both commands exit successfully with no lint errors or TypeScript
errors.

### Task 5: Verify, commit, and publish

**Files:**

- Verify: all files above and the complete working tree.

- [ ] **Step 1: Run the production build**

Run:

```bash
npm run build
```

Expected: Next.js production build completes successfully.

- [ ] **Step 2: Inspect the final diff and status**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD
```

Expected: only the intended implementation, tests, and README changes are
unstaged or staged; existing unrelated user changes remain untouched.

- [ ] **Step 3: Commit only the implementation files**

Stage the implementation files explicitly and use the repository's Lore commit
format, including the required co-author trailer:

```bash
git add repos/jormungand/lib/site-auth-attempts.ts repos/jormungand/proxy.ts repos/jormungand/tests/site-auth-attempts.test.ts repos/jormungand/README.md
git commit -m "Enforce per-IP Basic Auth failure lockouts" -m "Apply the approved process-local five-failure lockout to every protected site request while preserving the existing Basic Auth challenge." -m "Constraint: Locks must clear on service restart and no manual unlock API or external state store is allowed" -m "Rejected: External shared state | conflicts with restart-clears-locks requirement and adds deployment dependencies" -m "Confidence: high" -m "Scope-risk: moderate" -m "Directive: Preserve indistinguishable 401 responses for ordinary failures and locked IPs" -m "Tested: npm test; npm run lint; npm run typecheck; npm run build; git diff --check" -m "Not-tested: Multi-instance cross-process lock sharing" -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

- [ ] **Step 4: Confirm `main`, merge only if a non-main branch exists, and push**

Run:

```bash
git branch --show-current
git log -2 --oneline --decorate
git remote -v
git push origin main
```

If implementation is performed on a non-main branch, merge that branch into
`main` before the final push; the current workspace is already on `main`, so no
merge commit is expected unless the branch changes during execution.
