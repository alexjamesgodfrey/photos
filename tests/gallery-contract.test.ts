import { neonConfig } from "@neondatabase/serverless"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  GALLERY_COOKIE_NAME,
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
  isValidGalleryPersonSlug,
  listGalleryPeople,
  listGalleryPhotos,
  type GalleryCursor,
} from "../src/lib/gallery-db"
import peopleHandler from "../src/pages/api/people"
import photosHandler from "../src/pages/api/photos"
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

  const personCursor = encodeGalleryCursor({
    sort: "album",
    albumPosition: 73,
    id: "photo_0073",
    person: "person-alex",
  })
  assert.deepEqual(
    decodeGalleryCursor(personCursor, "album", "person-alex"),
    {
      sort: "album",
      albumPosition: 73,
      id: "photo_0073",
      person: "person-alex",
    }
  )
  assert.throws(
    () => decodeGalleryCursor(personCursor, "album"),
    InvalidGalleryCursorError
  )
  assert.throws(
    () => decodeGalleryCursor(personCursor, "album", "person-sierra"),
    InvalidGalleryCursorError
  )
  assert.throws(
    () => decodeGalleryCursor(albumCursor, "album", "person-alex"),
    InvalidGalleryCursorError
  )
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
  assert.throws(
    () =>
      encodeGalleryCursor({
        sort: "album",
        albumPosition: 1,
        id: "photo_0001",
        person: "Alex Godfrey",
      }),
    InvalidGalleryCursorError
  )
})

test("shuffled listings use seeded md5 keysets with stable opaque cursors", async (t) => {
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
  ]
  const calls: Array<{ query: string; params: unknown[] }> = []

  neonConfig.fetchFunction = async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string
      params: unknown[]
    }
    calls.push(body)
    const result = body.query.includes("FROM wedding_photos.albums")
      ? mockNeonResult(["photo_count"], [["990"]])
      : mockNeonResult(PHOTO_FIELDS, photoResponses.shift() ?? [])
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    })
  }
  t.after(() => {
    neonConfig.fetchFunction = undefined
  })

  const seed = "a1b2c3d4"
  const expectedKey = createHash("md5")
    .update(`${seed}:photo_0002`)
    .digest("hex")

  const firstPage = await listGalleryPhotos({
    limit: 2,
    sort: "shuffle",
    seed,
  })
  assert.equal(firstPage.photos.length, 2)
  assert.ok(firstPage.nextCursor)
  assert.deepEqual(
    decodeGalleryCursor(firstPage.nextCursor!, "shuffle", undefined, seed),
    {
      sort: "shuffle",
      seed,
      shuffleKey: expectedKey,
      id: "photo_0002",
    }
  )
  assert.throws(
    () =>
      decodeGalleryCursor(
        firstPage.nextCursor!,
        "shuffle",
        undefined,
        "deadbeef"
      ),
    InvalidGalleryCursorError
  )
  assert.throws(
    () => decodeGalleryCursor(firstPage.nextCursor!, "shuffle"),
    InvalidGalleryCursorError
  )
  assert.throws(
    () => decodeGalleryCursor(firstPage.nextCursor!, "album"),
    InvalidGalleryCursorError
  )

  const secondPage = await listGalleryPhotos({
    limit: 2,
    sort: "shuffle",
    seed,
    cursor: firstPage.nextCursor!,
  })
  assert.equal(secondPage.photos.length, 1)
  assert.equal(secondPage.nextCursor, null)

  const callCountBeforeRejectedInputs = calls.length
  await assert.rejects(
    () => listGalleryPhotos({ limit: 2, sort: "shuffle" }),
    /Invalid gallery shuffle seed/
  )
  await assert.rejects(
    () => listGalleryPhotos({ limit: 2, sort: "shuffle", seed: "XYZ" }),
    /Invalid gallery shuffle seed/
  )
  assert.equal(calls.length, callCountBeforeRejectedInputs)

  const photoCalls = calls.filter((call) =>
    call.query.includes("original_filename")
  )
  assert.equal(photoCalls.length, 2)
  assert.deepEqual(photoCalls[0].params, ["wedding", `${seed}:`, "3"])
  assert.match(
    photoCalls[0].query,
    /ORDER BY md5\(\$2 \|\| ph\.id\) ASC, ph\.id ASC/
  )
  assert.deepEqual(photoCalls[1].params, [
    "wedding",
    `${seed}:`,
    expectedKey,
    "photo_0002",
    "3",
  ])
  assert.match(
    photoCalls[1].query,
    /AND \(md5\(\$2 \|\| ph\.id\), ph\.id\) > \(\$3, \$4\)/
  )
})

test("person slugs accept only canonical bounded URL-safe values", () => {
  for (const value of [
    "person-alex",
    "alex",
    "henry-5",
    "person-1786b1749dfe",
  ]) {
    assert.equal(isValidGalleryPersonSlug(value), true)
  }

  for (const value of [
    "",
    "Alex",
    "alex godfrey",
    "-alex",
    "alex-",
    "alex--sierra",
    "alex_1",
    "a".repeat(129),
    null,
    42,
  ]) {
    assert.equal(isValidGalleryPersonSlug(value), false)
  }
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
    /ORDER BY ph\.album_position ASC, ph\.id ASC/
  )
  assert.deepEqual(photoCalls[1].params, [
    "wedding",
    "2",
    "photo_0002",
    "3",
  ])
  assert.match(
    photoCalls[1].query,
    /AND \(ph\.album_position, ph\.id\) > \(\$2, \$3\)/
  )
  assert.deepEqual(photoCalls[2].params, [
    "wedding",
    timestamp,
    "10",
    "photo_0010",
    "3",
  ])
  assert.match(photoCalls[2].query, /ph\.captured_at < \$2::timestamptz/)
  assert.match(photoCalls[2].query, /NULLS LAST/)
  assert.deepEqual(photoCalls[3].params, [
    "wedding",
    timestamp,
    "10",
    "photo_0010",
    "3",
  ])
  assert.match(photoCalls[3].query, /ph\.captured_at > \$2::timestamptz/)
  assert.match(photoCalls[3].query, /NULLS LAST/)
  assert.deepEqual(photoCalls[4].params, [
    "wedding",
    "20",
    "photo_0020",
    "3",
  ])
  assert.match(
    photoCalls[4].query,
    /AND ph\.captured_at IS NULL[\s\S]*AND \(ph\.album_position, ph\.id\) >/
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

test("people listing returns published counts and signed optional avatars", async (t) => {
  process.env.DATABASE_URL =
    "postgresql://gallery:password@mock.pg.psdb.cloud/postgres"
  process.env.GALLERY_ALBUM_ID = "wedding"
  process.env.MEDIA_BASE_URL = "https://media.example.test"
  process.env.MEDIA_SIGNING_SECRET = MEDIA_SECRET
  process.env.MEDIA_URL_TTL_SECONDS = "21600"

  const fields = [
    "id",
    "slug",
    "display_name",
    "avatar_key",
    "avatar_width",
    "avatar_height",
    "photo_count",
  ]
  const responses = [
    [
      [
        "person_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "person-alex",
        "Alex",
        "wedding/people/person_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/avatar-bbbbbbbbbbbbbbbbbbbb.webp",
        "320",
        "320",
        "382",
      ],
      [
        "person_bobbi",
        "person-bobbi",
        "Bobbi",
        null,
        null,
        null,
        "32",
      ],
    ],
    [
      [
        "person_invalid",
        "person-invalid",
        "Invalid",
        null,
        "320",
        null,
        "1",
      ],
    ],
  ]
  const calls: Array<{ query: string; params: unknown[] }> = []

  neonConfig.fetchFunction = async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string
      params: unknown[]
    }
    calls.push(body)
    return new Response(
      JSON.stringify(mockNeonResult(fields, responses.shift() ?? [])),
      { headers: { "Content-Type": "application/json" } }
    )
  }
  t.after(() => {
    neonConfig.fetchFunction = undefined
  })

  const result = await listGalleryPeople()
  assert.equal(result.people.length, 2)
  assert.equal(Number.isSafeInteger(result.mediaExpiresAt), true)
  assert.deepEqual(result.people[1], {
    id: "person_bobbi",
    slug: "person-bobbi",
    displayName: "Bobbi",
    photoCount: 32,
    avatarUrl: null,
    avatarWidth: null,
    avatarHeight: null,
  })

  const alex = result.people[0]
  assert.equal(alex.photoCount, 382)
  assert.equal(alex.avatarWidth, 320)
  assert.equal(alex.avatarHeight, 320)
  assert.ok(alex.avatarUrl)
  const avatarUrl = new URL(alex.avatarUrl!)
  assert.equal(
    avatarUrl.pathname,
    "/wedding/people/person_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/avatar-bbbbbbbbbbbbbbbbbbbb.webp"
  )
  assert.equal(
    Number(avatarUrl.searchParams.get("expires")),
    result.mediaExpiresAt
  )
  assert.equal(await hasValidSignedUrl(avatarUrl, MEDIA_SECRET), true)

  assert.deepEqual(calls[0].params, ["wedding"])
  assert.match(
    calls[0].query,
    /JOIN wedding_photos\.photo_people pp ON pp\.person_id = pe\.id/
  )
  assert.match(calls[0].query, /ph\.published = true/)
  assert.match(
    calls[0].query,
    /ORDER BY lower\(pe\.display_name\) ASC/
  )
  await assert.rejects(
    () => listGalleryPeople(),
    /invalid person avatar metadata/
  )
})

test("person-filtered listings use accurate counts and filter-bound keyset cursors", async (t) => {
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
  ]
  const calls: Array<{ query: string; params: unknown[] }> = []

  neonConfig.fetchFunction = async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string
      params: unknown[]
    }
    calls.push(body)
    const result = body.query.includes("count(*) AS photo_count")
      ? mockNeonResult(["photo_count"], [["3"]])
      : mockNeonResult(PHOTO_FIELDS, photoResponses.shift() ?? [])
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    })
  }
  t.after(() => {
    neonConfig.fetchFunction = undefined
  })

  const firstPage = await listGalleryPhotos({
    limit: 2,
    sort: "album",
    person: "person-alex",
  })
  assert.equal(firstPage.total, 3)
  assert.equal(firstPage.photos.length, 2)
  assert.ok(firstPage.nextCursor)
  assert.deepEqual(
    decodeGalleryCursor(
      firstPage.nextCursor!,
      "album",
      "person-alex"
    ),
    {
      sort: "album",
      albumPosition: 2,
      id: "photo_0002",
      person: "person-alex",
    }
  )

  const secondPage = await listGalleryPhotos({
    limit: 2,
    sort: "album",
    person: "person-alex",
    cursor: firstPage.nextCursor!,
  })
  assert.equal(secondPage.total, 3)
  assert.equal(secondPage.photos.length, 1)
  assert.equal(secondPage.nextCursor, null)

  const timestamp = "2026-07-27T01:23:45.123456Z"
  for (const sort of ["newest", "oldest"] as const) {
    await listGalleryPhotos({
      limit: 2,
      sort,
      person: "person-alex",
      cursor: encodeGalleryCursor({
        sort,
        person: "person-alex",
        capturedAt: timestamp,
        albumPosition: 10,
        id: "photo_0010",
      }),
    })
  }

  const callCountBeforeRejectedInputs = calls.length
  await assert.rejects(
    () =>
      listGalleryPhotos({
        limit: 2,
        sort: "album",
        person: "person-sierra",
        cursor: firstPage.nextCursor!,
      }),
    InvalidGalleryCursorError
  )
  await assert.rejects(
    () =>
      listGalleryPhotos({
        limit: 2,
        sort: "album",
        person: "Alex Godfrey",
      }),
    /Invalid gallery person slug/
  )
  assert.equal(calls.length, callCountBeforeRejectedInputs)

  const countCalls = calls.filter((call) =>
    call.query.includes("count(*) AS photo_count")
  )
  const photoCalls = calls.filter((call) =>
    call.query.includes("original_filename")
  )
  assert.equal(countCalls.length, 4)
  assert.equal(photoCalls.length, 4)
  assert.deepEqual(countCalls[0].params, ["wedding", "person-alex"])
  assert.match(countCalls[0].query, /AND pe\.slug = \$2/)
  assert.deepEqual(photoCalls[0].params, [
    "wedding",
    "person-alex",
    "3",
  ])
  assert.deepEqual(photoCalls[1].params, [
    "wedding",
    "person-alex",
    "2",
    "photo_0002",
    "3",
  ])
  assert.match(
    photoCalls[1].query,
    /AND \(ph\.album_position, ph\.id\) > \(\$3, \$4\)/
  )
  assert.deepEqual(photoCalls[2].params, [
    "wedding",
    "person-alex",
    timestamp,
    "10",
    "photo_0010",
    "3",
  ])
  assert.match(photoCalls[2].query, /ph\.captured_at < \$3::timestamptz/)
  assert.deepEqual(photoCalls[3].params, [
    "wedding",
    "person-alex",
    timestamp,
    "10",
    "photo_0010",
    "3",
  ])
  assert.match(photoCalls[3].query, /ph\.captured_at > \$3::timestamptz/)
})

interface ApiResponseState {
  statusCode: number
  body: unknown
  headers: Map<string, string | string[] | number>
}

function createApiResponse() {
  const state: ApiResponseState = {
    statusCode: 200,
    body: undefined,
    headers: new Map(),
  }
  const response = {
    setHeader(name: string, value: string | string[] | number) {
      state.headers.set(name.toLowerCase(), value)
      return response
    },
    status(statusCode: number) {
      state.statusCode = statusCode
      return response
    },
    json(body: unknown) {
      state.body = body
      return response
    },
  }
  return {
    state,
    response: response as unknown as Parameters<typeof photosHandler>[1],
  }
}

test("people API requires authentication and photos API rejects invalid person inputs", async (t) => {
  process.env.GALLERY_SESSION_SECRET = SESSION_SECRET
  process.env.DATABASE_URL =
    "postgresql://gallery:password@mock.pg.psdb.cloud/postgres"
  process.env.GALLERY_ALBUM_ID = "wedding"
  process.env.MEDIA_BASE_URL = "https://media.example.test"
  process.env.MEDIA_SIGNING_SECRET = MEDIA_SECRET
  neonConfig.fetchFunction = async () =>
    new Response(
      JSON.stringify(
        mockNeonResult(
          [
            "id",
            "slug",
            "display_name",
            "avatar_key",
            "avatar_width",
            "avatar_height",
            "photo_count",
          ],
          []
        )
      ),
      { headers: { "Content-Type": "application/json" } }
    )
  t.after(() => {
    neonConfig.fetchFunction = undefined
  })

  const unauthorized = createApiResponse()
  await peopleHandler(
    {
      method: "GET",
      headers: {},
      query: {},
    } as unknown as Parameters<typeof peopleHandler>[0],
    unauthorized.response
  )
  assert.equal(unauthorized.state.statusCode, 401)
  assert.deepEqual(unauthorized.state.body, {
    error: "Authentication required",
  })
  assert.equal(
    unauthorized.state.headers.get("cache-control"),
    "private, no-store, max-age=0"
  )

  const wrongMethod = createApiResponse()
  await peopleHandler(
    {
      method: "POST",
      headers: {},
      query: {},
    } as unknown as Parameters<typeof peopleHandler>[0],
    wrongMethod.response
  )
  assert.equal(wrongMethod.state.statusCode, 405)
  assert.equal(wrongMethod.state.headers.get("allow"), "GET")

  const cookie = `${GALLERY_COOKIE_NAME}=${createGallerySessionToken()}`
  const authorized = createApiResponse()
  await peopleHandler(
    {
      method: "GET",
      headers: { cookie },
      query: {},
    } as unknown as Parameters<typeof peopleHandler>[0],
    authorized.response
  )
  assert.equal(authorized.state.statusCode, 200)
  assert.equal(
    Number.isSafeInteger(
      (authorized.state.body as { mediaExpiresAt: number }).mediaExpiresAt
    ),
    true
  )
  assert.deepEqual(
    (authorized.state.body as { people: unknown[] }).people,
    []
  )

  for (const person of ["Alex Godfrey", "", "person_alex", ["person-alex"]]) {
    const invalid = createApiResponse()
    await photosHandler(
      {
        method: "GET",
        headers: { cookie },
        query: { person },
      } as unknown as Parameters<typeof photosHandler>[0],
      invalid.response
    )
    assert.equal(invalid.state.statusCode, 400)
    assert.deepEqual(invalid.state.body, { error: "Invalid person" })
  }
})
