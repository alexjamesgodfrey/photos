import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

export const GALLERY_COOKIE_NAME = "wedding_gallery_session"

const SESSION_VERSION = "v1"
const DEFAULT_SESSION_SECONDS = 60 * 60 * 24 * 30

function getSessionSecret(): string {
  const secret = process.env.GALLERY_SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      "GALLERY_SESSION_SECRET must be configured with at least 32 characters"
    )
  }
  return secret
}

function signatureFor(payload: string): string {
  return createHmac("sha256", getSessionSecret())
    .update(payload)
    .digest("base64url")
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}

function cookieDomain(): string | undefined {
  const value = process.env.GALLERY_COOKIE_DOMAIN?.trim()
  if (!value) return undefined
  if (!/^\.?[a-z0-9.-]+$/i.test(value)) {
    throw new Error("GALLERY_COOKIE_DOMAIN contains invalid characters")
  }
  return value
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}

  return header.split(";").reduce<Record<string, string>>((cookies, part) => {
    const separator = part.indexOf("=")
    if (separator === -1) return cookies
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (name) cookies[name] = value
    return cookies
  }, {})
}

export function createGallerySessionToken(
  now = Date.now(),
  maxAgeSeconds = DEFAULT_SESSION_SECONDS
): string {
  const expiresAt = Math.floor(now / 1000) + maxAgeSeconds
  const payload = `${SESSION_VERSION}.${expiresAt}`
  return `${payload}.${signatureFor(payload)}`
}

export function verifyGallerySessionToken(
  token: string | undefined,
  now = Date.now()
): boolean {
  if (!token) return false

  const [version, expiresAtValue, signature, extra] = token.split(".")
  if (
    version !== SESSION_VERSION ||
    !expiresAtValue ||
    !signature ||
    extra !== undefined
  ) {
    return false
  }

  const expiresAt = Number(expiresAtValue)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) {
    return false
  }

  const expected = signatureFor(`${version}.${expiresAtValue}`)
  return safeEqual(signature, expected)
}

export function hasGallerySession(request: IncomingMessage): boolean {
  const cookies = parseCookies(request.headers.cookie)
  return verifyGallerySessionToken(cookies[GALLERY_COOKIE_NAME])
}

export function createGallerySessionCookie(): string {
  const maxAge = Number(process.env.GALLERY_SESSION_MAX_AGE_SECONDS)
  const maxAgeSeconds =
    Number.isSafeInteger(maxAge) && maxAge > 0
      ? maxAge
      : DEFAULT_SESSION_SECONDS
  const token = createGallerySessionToken(Date.now(), maxAgeSeconds)
  const attributes = [
    `${GALLERY_COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ]
  if (process.env.NODE_ENV === "production") attributes.push("Secure")
  const domain = cookieDomain()
  if (domain) attributes.push(`Domain=${domain}`)
  return attributes.join("; ")
}

export function clearGallerySessionCookie(): string {
  const attributes = [
    `${GALLERY_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ]
  if (process.env.NODE_ENV === "production") attributes.push("Secure")
  const domain = cookieDomain()
  if (domain) attributes.push(`Domain=${domain}`)
  return attributes.join("; ")
}

export function isGalleryAccessCodeValid(candidate: string): boolean {
  const configuredHash = process.env.GALLERY_ACCESS_CODE_SHA256?.toLowerCase()
  if (!configuredHash || !/^[a-f0-9]{64}$/.test(configuredHash)) {
    throw new Error("GALLERY_ACCESS_CODE_SHA256 is not configured")
  }

  const candidateHash = createHash("sha256").update(candidate).digest("hex")
  return safeEqual(candidateHash, configuredHash)
}
