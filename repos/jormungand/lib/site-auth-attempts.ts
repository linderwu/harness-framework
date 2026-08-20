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
