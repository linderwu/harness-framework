import { timingSafeEqual } from "crypto"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { shouldRequireSiteAuthentication } from "./lib/site-auth"

const authRealm = "Jormungandr"

export function proxy(request: NextRequest) {
  if (
    !shouldRequireSiteAuthentication(
      request.method,
      process.env.SITE_AUTH_MODE
    )
  ) {
    return NextResponse.next()
  }

  const username = process.env.SITE_AUTH_USERNAME
  const password = process.env.SITE_AUTH_PASSWORD

  if (!username || !password) {
    return new NextResponse("Site authentication is not configured.", {
      status: 503
    })
  }

  if (hasValidBasicAuth(request, username, password)) {
    return NextResponse.next()
  }

  return new NextResponse("Authentication required.", {
    headers: {
      "WWW-Authenticate": `Basic realm="${authRealm}", charset="UTF-8"`
    },
    status: 401
  })
}

function hasValidBasicAuth(
  request: NextRequest,
  expectedUsername: string,
  expectedPassword: string
) {
  const authorization = request.headers.get("authorization")

  if (!authorization?.startsWith("Basic ")) {
    return false
  }

  const decodedCredentials = Buffer.from(
    authorization.slice("Basic ".length),
    "base64"
  ).toString("utf8")
  const separatorIndex = decodedCredentials.indexOf(":")

  if (separatorIndex === -1) {
    return false
  }

  const username = decodedCredentials.slice(0, separatorIndex)
  const password = decodedCredentials.slice(separatorIndex + 1)

  return (
    constantTimeEquals(username, expectedUsername) &&
    constantTimeEquals(password, expectedPassword)
  )
}

function constantTimeEquals(value: string, expectedValue: string) {
  const valueBuffer = Buffer.from(value)
  const expectedValueBuffer = Buffer.from(expectedValue)

  return (
    valueBuffer.length === expectedValueBuffer.length &&
    timingSafeEqual(valueBuffer, expectedValueBuffer)
  )
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|health$).*)"]
}
