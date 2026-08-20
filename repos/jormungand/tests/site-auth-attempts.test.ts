import assert from "node:assert/strict"
import test from "node:test"

import { NextRequest } from "next/server"

import { proxy } from "../proxy"

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
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

test("locks an IP after five failures even when correct credentials follow", (t) => {
  configureSiteAuth(t)

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
