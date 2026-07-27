import { WorkerEntrypoint } from "cloudflare:workers"
import { getValidSignedUrlExpiration } from "./media-auth.mjs"

const BROWSER_CACHE_SECONDS = 60 * 60 * 6
const EDGE_CACHE_SECONDS = 60 * 60 * 24 * 365
const DEFAULT_CACHE_SCHEMA_VERSION = "v1"

function unauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "public, max-age=180",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function objectKeyFrom(url) {
  const encodedPath = url.pathname.replace(/^\/+/, "")
  if (!encodedPath) return null

  try {
    const segments = encodedPath.split("/").map(decodeURIComponent)
    if (
      segments.some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\0")
      )
    ) {
      return null
    }
    return segments.join("/")
  } catch {
    return null
  }
}

function browserCacheControl(expiresAt, responseIsSuccessful) {
  const remainingSeconds = Math.max(
    0,
    expiresAt - Math.ceil(Date.now() / 1000)
  )
  const responseCap = responseIsSuccessful ? BROWSER_CACHE_SECONDS : 180
  const maxAge = Math.min(responseCap, remainingSeconds)
  return responseIsSuccessful
    ? `private, max-age=${maxAge}, immutable`
    : `private, max-age=${maxAge}`
}

function cacheSchemaVersion(env) {
  const configured = env.MEDIA_CACHE_SCHEMA_VERSION
  return typeof configured === "string" &&
    /^[A-Za-z0-9._-]{1,64}$/.test(configured)
    ? configured
    : DEFAULT_CACHE_SCHEMA_VERSION
}

export class MediaObject extends WorkerEntrypoint {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      })
    }

    const objectKey = objectKeyFrom(new URL(request.url))
    if (!objectKey) return notFound()

    const object =
      request.method === "HEAD"
        ? await this.env.PHOTOS.head(objectKey)
        : await this.env.PHOTOS.get(objectKey)
    if (!object) return notFound()

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set(
      "Cache-Control",
      `public, max-age=${EDGE_CACHE_SECONDS}, immutable`
    )
    headers.set(
      "Cloudflare-CDN-Cache-Control",
      `public, max-age=${EDGE_CACHE_SECONDS}, immutable`
    )
    headers.set("Content-Length", String(object.size))
    headers.set("ETag", object.httpEtag)
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Cross-Origin-Resource-Policy", "cross-origin")

    return new Response(request.method === "HEAD" ? null : object.body, {
      headers,
    })
  }
}

export default {
  async fetch(request, env, context) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      })
    }

    const url = new URL(request.url)
    const mediaExpiresAt = await getValidSignedUrlExpiration(
      url,
      env.MEDIA_SIGNING_SECRET
    )
    if (mediaExpiresAt === null) return unauthorized()

    if (!objectKeyFrom(url)) return notFound()

    // Signed query parameters never enter the shared cache key. The explicit
    // schema version lets a later header/body contract change coexist safely
    // with cross-version cache reuse.
    const normalizedUrl = new URL(url)
    normalizedUrl.search = ""
    normalizedUrl.searchParams.set(
      "__media_cache",
      cacheSchemaVersion(env)
    )
    if (request.method === "HEAD") {
      // Keep a header-only R2 lookup from populating the GET cache entry.
      normalizedUrl.searchParams.set("__method", "head")
    }

    const forwardedHeaders = new Headers(request.headers)
    forwardedHeaders.delete("Authorization")
    forwardedHeaders.delete("Cookie")
    const forwarded = new Request(normalizedUrl.toString(), {
      method: request.method,
      headers: forwardedHeaders,
    })
    const response = await context.exports.MediaObject.fetch(forwarded)
    const headers = new Headers(response.headers)
    headers.set(
      "Cache-Control",
      browserCacheControl(mediaExpiresAt, response.ok)
    )
    headers.delete("Cloudflare-CDN-Cache-Control")

    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
}
