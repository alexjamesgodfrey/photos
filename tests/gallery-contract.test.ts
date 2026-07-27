import { neonConfig } from "@neondatabase/serverless"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  createGallerySessionCookie,
  createGallerySessionToken,
  isGalleryAccessCodeValid,
  verifyGallerySessionToken,
} from "../src/lib/gallery-session"
import {
  createSignedMediaUrl,
  decodeGalleryCursor,
  encodeGalleryCursor,
  galleryMediaExpiresAt,
  InvalidGalleryCursorError,
  listGalleryPhotos,
  type GalleryCursor,
} from "../src/lib/gallery-db"
import {
  getValidSignedUrlExpiration,
  hasValidSignedUrl,
} from "../cloudflare/media-auth.mjs"

const SESSION_SECRET =
  "test-gallery-session-secret-0123456789abcdef"
const MEDIA_SECRET =
  "test-media-signing-secret-abcdefghijklmnopqrstuvwxyz"

test("session tokens and access codes use the application-only secret", () => {
  process.env.GALLERY_SESSION_SECRET = SESSION_SECRET
  process.env.GALLERY_ACCESS_CODE_SHA256 = createHash("sha256")
    .update("correct horse battery staple")
    .digest("hex")
  delete process.env.GALLERY_COOKIE_DOMAIN

  const token = createGallerySessionToken(Date.now(), 3600)
  assert.equal(verifyGallerySessionToken(token), true)
  assert.equal(verifyGallerySessionToken(`${token}tampered`), false)
  assert.equal(isGalleryAccessCodeValid("correct horse battery staple"), true)
  assert.equal(isGalleryAccessCodeValid("wrong"), false)
  assert.doesNotMatch(createGallerySessionCookie(), /;\s*Domain=/i)
})

test("media URLs use a separate secret and a stable page expiration", async () => {
  process.env.GALLERY_SESSION_SECRET = SESSION_SECRET
  process.env.MEDIA_BASE_URL = "https://media.example.test"
  process.env.MEDIA_URL_TTL_SECONDS = "21600"
  delete process.env.MEDIA_SIGNING_SECRET

  assert.throws(
    () => createSignedMediaUrl("wedding/test/photo.webp"),
    /MEDIA_SIGNING_SECRET/
  )

  process.env.MEDIA_SIGNING_SECRET = MEDIA_SECRET
  const signingWindowSeconds = 300
  const fixedSeconds = 1_900_000_000
  const windowStart =
    fixedSeconds - (fixedSeconds % signingWindowSeconds)
  const now = (windowStart + 120) * 1000
  const first = new URL(
    createSignedMediaUrl("wedding/test/a photo.webp", now)
  )
  const sameWindow = new URL(
    createSignedMediaUrl("wedding/test/a photo.webp", now + 30_000)
  )
  const anotherObject = new URL(
    createSignedMediaUrl("wedding/test/another.webp", now)
  )
  const expires = Number(first.searchParams.get("expires"))
  const lifetime = expires - now / 1000

  assert.equal(first.toString(), sameWindow.toString())
  assert.equal(expires, galleryMediaExpiresAt(now))
  assert.equal(
    anotherObject.searchParams.get("expires"),
    first.searchParams.get("expires")
  )
  assert.ok(lifetime >= 21600 && lifetime <= 21900)
  assert.equal(
    await getValidSignedUrlExpiration(first, MEDIA_SECRET, now),
    expires
  )
  assert.equal(await hasValidSignedUrl(first, MEDIA_SECRET, now), true)
  assert.equal(await hasValidSignedUrl(first, SESSION_SECRET, now), false)

  const wrongPath = new URL(first)
  wrongPath.pathname = "/wedding/test/other.webp"
  assert.equal(await hasValidSignedUrl(wrongPath, MEDIA_SECRET, now), false)

  const tampered = new URL(first)
  tampered.searchParams.set("signature", "tampered")
  assert.equal(await hasValidSignedUrl(tampered, MEDIA_SECRET, now), false)

  const nonCanonicalExpiration = new URL(first)
  nonCanonicalExpiration.searchParams.set("expires", `0${expires}`)
  assert.equal(
    await hasValidSignedUrl(nonCanonicalExpiration, MEDIA_SECRET, now),
    false
  )
  assert.equal(
    await hasValidSignedUrl(first, MEDIA_SECRET, expires * 1000),
    false
  )
})

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

test("opaque cursors round-trip every stable keyset tuple", () => {
  const albumCursor = encodeGalleryCursor({
    sort: "album",
    albumPosition: 42,
    id: "photo_0042",
  })
  assert.match(albumCursor, /^[A-Za-z0-9_-]+$/)
  assert.doesNotMatch(albumCursor, /photo_0042/)
  assert.deepEqual(decodeGalleryCursor(albumCursor, "album"), {
    sort: "album",
    albumPosition: 42,
    id: "photo_0042",
  })

  const capturedAt = "2026-07-27T01:23:45.123456Z"
  for (const sort of ["newest", "oldest"] as const) {
    const cursor = encodeGalleryCursor({
      sort,
      capturedAt,
      albumPosition: 42,
      id: "photo_0042",
    })
    assert.deepEqual(decodeGalleryCursor(cursor, sort), {
      sort,
      capturedAt,
      albumPosition: 42,
      id: "photo_0042",
    })
  }

  const nullTimestampCursor = encodeGalleryCursor({
    sort: "oldest",
    capturedAt: null,
    albumPosition: 990,
    id: "photo_0990",
  })
  assert.deepEqual(decodeGalleryCursor(nullTimestampCursor, "oldest"), {
    sort: "oldest",
    capturedAt: null,
    albumPosition: 990,
    id: "photo_0990",
  })
})

test("cursors reject malformed, non-canonical, and sort-mismatched input", () => {
  const validAlbumCursor = encodeGalleryCursor({
    sort: "album",
    albumPosition: 1,
    id: "photo_0001",
  })

  const malformed = [
    "",
    "0",
    `${validAlbumCursor}=`,
    "a".repeat(1_025),
    Buffer.from("not json", "utf8").toString("base64url"),
    rawCursor({
      v: 2,
      s: "album",
      p: 1,
      i: "photo_0001",
    }),
    rawCursor({
      v: 1,
      s: "album",
      p: -1,
      i: "photo_0001",
    }),
    rawCursor({
      v: 1,
      s: "album",
      p: 1,
      i: "photo_0001",
      unexpected: true,
    }),
    rawCursor({
      v: 1,
      s: "newest",
      t: "2026-07-27T01:23:45+00:00",
      p: 1,
      i: "photo_0001",
    }),
  ]

  for (const cursor of malformed) {
    assert.throws(
      () => decodeGalleryCursor(cursor, "album"),
      InvalidGalleryCursorError
    )
  }
  assert.throws(
    () => decodeGalleryCursor(validAlbumCursor, "newest"),
    InvalidGalleryCursorError
  )
  assert.throws(
    () =>
      encodeGalleryCursor({
        sort: "album",
        albumPosition: -1,
        id: "photo_0001",
      } as GalleryCursor),
    InvalidGalleryCursorError
  )
})

const PHOTO_FIELDS = [
  "id",
  "original_filename",
  "captured_at",
  "captured_at_cursor",
  "album_position",
  "width",
  "height",
  "thumb_key",
  "display_key",
  "blur_data_url",
]

function mockNeonResult(fields: string[], rows: unknown[][]) {
  return {
    command: "SELECT",
    fields: fields.map((name) => ({ name, dataTypeID: 25 })),
    rowCount: rows.length,
    rows,
  }
}

function mockPhotoRow(
  id: string,
  albumPosition: number,
  capturedAt = "2026-07-27T01:23:45.123Z",
  capturedAtCursor = "2026-07-27T01:23:45.123000Z"
) {
  return [
    id,
    `${id}.jpg`,
    capturedAt,
    capturedAtCursor,
    String(albumPosition),
    "1600",
    "1067",
    `wedding/thumb/${id}.webp`,
    `wedding/display/${id}.webp`,
    null,
  ]
}

test("photo listing uses album totals, limit+1, fresh timeouts, and keyset queries", async (t) => {
  process.env.DATABASE_URL =
    "postgresql://gallery:password@mock.pg.psdb.cloud/postgres"
  process.env.GALLERY_ALBUM_ID = "wedding"
  process.env.MEDIA_BASE_URL = "https://media.example.test"
  process.env.MEDIA_SIGNING_SECRET = MEDIA_SECRET
  process.env.MEDIA_URL_TTL_SECONDS = "21600"

  const photoResponses = [
    [
      mockPhotoRow("photo_0001", 1),
      mockPhotoRow("photo_0002", 2),
      mockPhotoRow("photo_0003", 3),
    ],
    [mockPhotoRow("photo_0003", 3)],
    [],
    [],
    [],
  ]
  const calls: Array<{
    query: string
    params: unknown[]
    signal: AbortSignal | null | undefined
  }> = []
  const timeoutDurations: number[] = []
  const originalAbortTimeout = AbortSignal.timeout
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (milliseconds: number) => {
      timeoutDurations.push(milliseconds)
      return originalAbortTimeout(milliseconds)
    },
  })

  neonConfig.fetchFunction = async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string
      params: unknown[]
    }
    calls.push({
      ...body,
      signal: init?.signal,
    })

    const result = body.query.includes(
      "FROM wedding_photos.albums"
    )
      ? mockNeonResult(["photo_count"], [["990"]])
      : mockNeonResult(PHOTO_FIELDS, photoResponses.shift() ?? [])

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    })
  }
  t.after(() => {
    neonConfig.fetchFunction = undefined
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: originalAbortTimeout,
    })
  })

  const firstPage = await listGalleryPhotos({
    limit: 2,
    sort: "album",
  })
  assert.equal(firstPage.total, 990)
  assert.equal(firstPage.photos.length, 2)
  assert.ok(firstPage.nextCursor)
  assert.equal(Number.isSafeInteger(firstPage.mediaExpiresAt), true)
  assert.deepEqual(
    decodeGalleryCursor(firstPage.nextCursor!, "album"),
    {
      sort: "album",
      albumPosition: 2,
      id: "photo_0002",
    }
  )
  for (const photo of firstPage.photos) {
    for (const mediaUrl of [photo.thumbUrl, photo.displayUrl]) {
      const url = new URL(mediaUrl)
      assert.equal(
        Number(url.searchParams.get("expires")),
        firstPage.mediaExpiresAt
      )
      assert.equal(await hasValidSignedUrl(url, MEDIA_SECRET), true)
    }
  }

  const secondPage = await listGalleryPhotos({
    limit: 2,
    sort: "album",
    cursor: firstPage.nextCursor!,
  })
  assert.equal(secondPage.photos.length, 1)
  assert.equal(secondPage.nextCursor, null)

  const timestamp = "2026-07-27T01:23:45.123456Z"
  await listGalleryPhotos({
    limit: 2,
    sort: "newest",
    cursor: encodeGalleryCursor({
      sort: "newest",
      capturedAt: timestamp,
      albumPosition: 10,
      id: "photo_0010",
    }),
  })
  await listGalleryPhotos({
    limit: 2,
    sort: "oldest",
    cursor: encodeGalleryCursor({
      sort: "oldest",
      capturedAt: timestamp,
      albumPosition: 10,
      id: "photo_0010",
    }),
  })
  await listGalleryPhotos({
    limit: 2,
    sort: "newest",
    cursor: encodeGalleryCursor({
      sort: "newest",
      capturedAt: null,
      albumPosition: 20,
      id: "photo_0020",
    }),
  })

  const albumCalls = calls.filter((call) =>
    call.query.includes("FROM wedding_photos.albums")
  )
  const photoCalls = calls.filter((call) =>
    call.query.includes("FROM wedding_photos.photos")
  )
  assert.equal(albumCalls.length, 5)
  assert.equal(photoCalls.length, 5)
  assert.deepEqual(photoCalls[0].params, ["wedding", "3"])
  assert.match(
    photoCalls[0].query,
    /ORDER BY album_position ASC, id ASC/
  )
  assert.deepEqual(photoCalls[1].params, [
    "wedding",
    "2",
    "photo_0002",
    "3",
  ])
  assert.match(
    photoCalls[1].query,
    /AND \(album_position, id\) > \(\$2, \$3\)/
  )
  assert.deepEqual(photoCalls[2].params, [
    "wedding",
    timestamp,
    "10",
    "photo_0010",
    "3",
  ])
  assert.match(photoCalls[2].query, /captured_at < \$2::timestamptz/)
  assert.match(photoCalls[2].query, /NULLS LAST/)
  assert.deepEqual(photoCalls[3].params, [
    "wedding",
    timestamp,
    "10",
    "photo_0010",
    "3",
  ])
  assert.match(photoCalls[3].query, /captured_at > \$2::timestamptz/)
  assert.match(photoCalls[3].query, /NULLS LAST/)
  assert.deepEqual(photoCalls[4].params, [
    "wedding",
    "20",
    "photo_0020",
    "3",
  ])
  assert.match(
    photoCalls[4].query,
    /AND captured_at IS NULL[\s\S]*AND \(album_position, id\) >/
  )

  const requestSignals = calls.map((call) => call.signal)
  assert.equal(
    requestSignals.every((signal) => signal instanceof AbortSignal),
    true
  )
  const distinctSignals = new Set(requestSignals)
  assert.equal(distinctSignals.size, 5)
  assert.deepEqual(timeoutDurations, [8_000, 8_000, 8_000, 8_000, 8_000])
  for (const signal of distinctSignals) {
    assert.equal(
      requestSignals.filter((candidate) => candidate === signal).length,
      2
    )
  }
})
