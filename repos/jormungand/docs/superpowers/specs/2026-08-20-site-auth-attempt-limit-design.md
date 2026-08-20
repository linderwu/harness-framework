# Site Basic Auth Attempt Limit Design

## Context

Jormungand currently protects the site through `proxy.ts` with HTTP Basic Auth.
There is no separate `/login` route. The configured credentials come from
`SITE_AUTH_USERNAME` and `SITE_AUTH_PASSWORD`, and failed requests currently
receive the same `401 Unauthorized` response with a `WWW-Authenticate` header.

## Goal

Limit repeated authentication failures without changing the existing Basic Auth
contract:

- Count failures per source IP.
- Count all authentication failures, including a missing or malformed
  `Authorization` header.
- Lock the source IP permanently after five consecutive failures.
- Clear an IP's failure state after a successful authentication.
- Keep the lock in process memory so restarting the service clears all locks.
- Keep locked responses indistinguishable from ordinary authentication failures:
  `401 Unauthorized` with the existing `WWW-Authenticate` header.
- Apply the behavior to every request protected by site Basic Auth.

## Non-goals

- No database, Redis, or other external state store.
- No administrative unlock API or user-facing unlock route.
- No change to public health, Agent Card, or configured A2A bypass behavior.
- No change to credential storage or Basic Auth credential comparison.

## Design

### Components

Add a small in-memory attempt-tracker module, for example
`lib/site-auth-attempts.ts`. The module exposes a testable tracker abstraction
and a process-level tracker used by `proxy.ts`.

The tracker owns only per-IP state:

- failed attempt count;
- whether the IP has reached the lock threshold.

`proxy.ts` remains responsible for route bypass decisions, IP extraction,
credential validation, and HTTP responses. It delegates counting and clearing
to the tracker.

### Request flow

1. Preserve existing bypass and `SITE_AUTH_MODE` checks.
2. Resolve the request source IP.
3. If the IP is already locked, return the existing authentication challenge.
4. If the supplied credentials are valid, clear the IP state and continue.
5. Otherwise, record a failure for the IP and return the existing authentication
   challenge.
6. The fifth failure marks the IP locked; that response and every later request
   from the IP remain `401 Unauthorized`.

The locked branch must not perform credential comparison. This keeps the
response path consistent and avoids unnecessary work after lockout.

### Source IP resolution

Resolve the IP in this order:

1. The first value in `x-forwarded-for`.
2. `x-real-ip`.
3. The fixed key `unknown` when neither header exists.

The deployment is expected to provide these headers through its reverse proxy.
If they are absent, requests share the `unknown` bucket by design rather than
silently bypassing the limit.

### Failure semantics

All requests that reach site authentication and are not successfully
authenticated count as failures. This includes:

- no `Authorization` header;
- non-Basic authorization schemes;
- malformed Basic payloads;
- credentials that do not match the configured username and password.

Requests bypassed before site authentication do not count. A successful
authentication removes the IP's state entirely, so the next failure starts at
one.

### Response and security behavior

Use the existing `401 Unauthorized` response and
`WWW-Authenticate: Basic realm="Jormungandr", charset="UTF-8"` header for:

- ordinary authentication failures;
- locked IPs.

Do not reveal lock state in response bodies, status codes, headers, or logs. Do
not log credentials or authorization headers. Preserve the existing `503`
response when site credentials are not configured.

## Testing

Add unit coverage for the tracker:

- first four failures remain retryable;
- the fifth failure locks the IP;
- locked IPs remain locked;
- successful authentication clears the state;
- distinct IPs have independent state.

Add proxy behavior coverage for:

- missing and malformed authorization counting as failures;
- locked IPs returning `401` even with correct credentials;
- successful authentication clearing the counter;
- IP extraction precedence and fallback behavior;
- unchanged public bypass, A2A bypass, `WWW-Authenticate`, and missing-config
  behavior.

Proxy tests should set explicit `x-forwarded-for` values so that tests do not
accidentally share the `unknown` bucket. Run the repository's test suite,
lint, typecheck, and production build after implementation.

## Risks and constraints

The state is local to one Node.js process. If the deployment runs multiple
independent instances, each instance has its own counters and restart scope.
This is an intentional consequence of the requirement that restarting the
service clears locks and that no external state store be introduced.

