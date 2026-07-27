import { neon, neonConfig, type NeonQueryFunction } from "@neondatabase/serverless"
import { Buffer } from "node:buffer"
import { createHmac } from "node:crypto"

export type GallerySort = "album" | "newest" | "oldest"

export interface GalleryPhoto {
  id: string
  thumbUrl: string
  displayUrl: string
  width: number
  height: number
  capturedAt: string | null
  filename: string
  blurDataUrl: string | null
}

export type GalleryCursor =
  | {
      sort: "album"
      albumPosition: number
      id: string
    }
  | {
      sort: "newest" | "oldest"
      capturedAt: string | null
      albumPosition: number
      id: string
    }

interface GalleryPhotoRow {
  id: string
  original_filename: string
  captured_at: string | Date | null
  captured_at_cursor: string | null
  album_position: number
  width: number
  height: number
  thumb_key: string
  display_key: string
  blur_data_url: string | null
}

interface AlbumCountRow {
  photo_count: number | string
}

interface PhotoQuery {
  text: string
  params: Array<string | number>
}

let sqlClient: NeonQueryFunction<false, false> | undefined
const DEFAULT_ALBUM_ID = "wedding"
const DEFAULT_MEDIA_TTL_SECONDS = 60 * 60 * 6
const MAX_MEDIA_TTL_SECONDS = 60 * 60 * 24
const SIGNING_WINDOW_SECONDS = 60 * 5
const DATABASE_TIMEOUT_MS = 8_000
const MAX_PAGE_SIZE = 120
const MAX_CURSOR_LENGTH = 1_024
const MAX_CURSOR_ID_LENGTH = 512
const MAX_POSTGRES_INTEGER = 2_147_483_647

export class InvalidGalleryCursorError extends Error {
  constructor() {
    super("Invalid gallery cursor")
    this.name = "InvalidGalleryCursorError"
  }
}

function database(): NeonQueryFunction<false, false> {
  if (sqlClient) return sqlClient

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured")
  }

  neonConfig.fetchEndpoint = (host) => `https://${host}/sql`
  sqlClient = neon(connectionString)
  return sqlClient
}

function galleryAlbumId(): string {
  const albumId = process.env.GALLERY_ALBUM_ID?.trim() || DEFAULT_ALBUM_ID
  if (albumId.length > 128) {
    throw new Error("GALLERY_ALBUM_ID is invalid")
  }
  return albumId
}

function mediaSigningSecret(): string {
  const signingSecret = process.env.MEDIA_SIGNING_SECRET
  if (!signingSecret || signingSecret.length < 32) {
    throw new Error("MEDIA_SIGNING_SECRET is not configured")
  }
  return signingSecret
}

function configuredMediaTtlSeconds(): number {
  const configuredTtl = Number(process.env.MEDIA_URL_TTL_SECONDS)
  return Number.isSafeInteger(configuredTtl) &&
    configuredTtl >= SIGNING_WINDOW_SECONDS &&
    configuredTtl <= MAX_MEDIA_TTL_SECONDS
    ? configuredTtl
    : DEFAULT_MEDIA_TTL_SECONDS
}

export function galleryMediaExpiresAt(now = Date.now()): number {
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("Invalid signing time")
  }

  // Snap expirations to a short window so independently rendered pages can
  // reuse the same edge-cached object without extending its configured TTL by
  // more than one signing window.
  return (
    Math.ceil(now / 1000 / SIGNING_WINDOW_SECONDS) * SIGNING_WINDOW_SECONDS +
    configuredMediaTtlSeconds()
  )
}

function createSignedMediaUrlAtExpiry(
  objectKey: string,
  expiresAt: number
): string {
  const baseUrl = process.env.MEDIA_BASE_URL?.replace(/\/+$/, "")
  if (!baseUrl) throw new Error("MEDIA_BASE_URL is not configured")
  if (!objectKey || objectKey.startsWith("/") || objectKey.includes("\0")) {
    throw new Error("Invalid media object key")
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error("Invalid media expiration")
  }

  const encodedPath = objectKey.split("/").map(encodeURIComponent).join("/")
  const signature = createHmac("sha256", mediaSigningSecret())
    .update(`media:${encodedPath}:${expiresAt}`)
    .digest("base64url")

  return `${baseUrl}/${encodedPath}?expires=${expiresAt}&signature=${signature}`
}

export function createSignedMediaUrl(
  objectKey: string,
  now = Date.now()
): string {
  return createSignedMediaUrlAtExpiry(objectKey, galleryMediaExpiresAt(now))
}

function invalidCursor(): never {
  throw new InvalidGalleryCursorError()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: string[]
): boolean {
  const actualKeys = Object.keys(value).sort()
  const sortedExpectedKeys = [...expectedKeys].sort()
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  )
}

function validCursorPosition(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= MAX_POSTGRES_INTEGER
  )
}

function validCursorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CURSOR_ID_LENGTH &&
    !value.includes("\0")
  )
}

function validCursorTimestamp(value: unknown): value is string | null {
  if (value === null) return true
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(
      value
    )
  ) {
    return false
  }

  return Number.isFinite(Date.parse(value))
}

export function encodeGalleryCursor(cursor: GalleryCursor): string {
  if (
    !validCursorPosition(cursor.albumPosition) ||
    !validCursorId(cursor.id)
  ) {
    return invalidCursor()
  }

  const payload =
    cursor.sort === "album"
      ? {
          v: 1,
          s: cursor.sort,
          p: cursor.albumPosition,
          i: cursor.id,
        }
      : {
          v: 1,
          s: cursor.sort,
          t: cursor.capturedAt,
          p: cursor.albumPosition,
          i: cursor.id,
        }

  if (
    cursor.sort !== "album" &&
    !validCursorTimestamp(cursor.capturedAt)
  ) {
    return invalidCursor()
  }

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

export function decodeGalleryCursor(
  encodedCursor: string,
  expectedSort: GallerySort
): GalleryCursor {
  if (
    typeof encodedCursor !== "string" ||
    encodedCursor.length === 0 ||
    encodedCursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encodedCursor)
  ) {
    return invalidCursor()
  }

  let decoded: Buffer
  let parsed: unknown
  try {
    decoded = Buffer.from(encodedCursor, "base64url")
    if (decoded.toString("base64url") !== encodedCursor) {
      return invalidCursor()
    }
    parsed = JSON.parse(decoded.toString("utf8"))
  } catch {
    return invalidCursor()
  }

  if (!isRecord(parsed) || parsed.v !== 1 || parsed.s !== expectedSort) {
    return invalidCursor()
  }
  if (!validCursorPosition(parsed.p) || !validCursorId(parsed.i)) {
    return invalidCursor()
  }

  if (expectedSort === "album") {
    if (!hasExactKeys(parsed, ["v", "s", "p", "i"])) {
      return invalidCursor()
    }
    return {
      sort: "album",
      albumPosition: parsed.p,
      id: parsed.i,
    }
  }

  if (
    !hasExactKeys(parsed, ["v", "s", "t", "p", "i"]) ||
    !validCursorTimestamp(parsed.t)
  ) {
    return invalidCursor()
  }

  return {
    sort: expectedSort,
    capturedAt: parsed.t,
    albumPosition: parsed.p,
    id: parsed.i,
  }
}

function buildPhotoQuery(
  albumId: string,
  sort: GallerySort,
  cursor: GalleryCursor | undefined,
  requestedRows: number
): PhotoQuery {
  const select = `
    SELECT
      id,
      original_filename,
      captured_at,
      to_char(
        captured_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS captured_at_cursor,
      album_position,
      width,
      height,
      thumb_key,
      display_key,
      blur_data_url
    FROM wedding_photos.photos
    WHERE album_id = $1 AND published = true
  `

  if (sort === "album") {
    if (!cursor) {
      return {
        text: `${select}
          ORDER BY album_position ASC, id ASC
          LIMIT $2
        `,
        params: [albumId, requestedRows],
      }
    }

    return {
      text: `${select}
        AND (album_position, id) > ($2, $3)
        ORDER BY album_position ASC, id ASC
        LIMIT $4
      `,
      params: [albumId, cursor.albumPosition, cursor.id, requestedRows],
    }
  }

  const orderDirection = sort === "newest" ? "DESC" : "ASC"
  const comparison = sort === "newest" ? "<" : ">"

  if (!cursor) {
    return {
      text: `${select}
        ORDER BY captured_at ${orderDirection} NULLS LAST,
                 album_position ASC,
                 id ASC
        LIMIT $2
      `,
      params: [albumId, requestedRows],
    }
  }

  if (cursor.sort === "album") {
    return invalidCursor()
  }

  if (cursor.capturedAt === null) {
    return {
      text: `${select}
        AND captured_at IS NULL
        AND (album_position, id) > ($2, $3)
        ORDER BY captured_at ${orderDirection} NULLS LAST,
                 album_position ASC,
                 id ASC
        LIMIT $4
      `,
      params: [albumId, cursor.albumPosition, cursor.id, requestedRows],
    }
  }

  return {
    text: `${select}
      AND (
        captured_at IS NULL
        OR captured_at ${comparison} $2::timestamptz
        OR (
          captured_at = $2::timestamptz
          AND (album_position, id) > ($3, $4)
        )
      )
      ORDER BY captured_at ${orderDirection} NULLS LAST,
               album_position ASC,
               id ASC
      LIMIT $5
    `,
    params: [
      albumId,
      cursor.capturedAt,
      cursor.albumPosition,
      cursor.id,
      requestedRows,
    ],
  }
}

function normalizeCapturedAt(value: string | Date | null): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Database returned an invalid capture time")
  }
  return date.toISOString()
}

function rowCursor(row: GalleryPhotoRow, sort: GallerySort): GalleryCursor {
  const albumPosition = Number(row.album_position)
  if (!validCursorPosition(albumPosition)) {
    throw new Error("Database returned an invalid album position")
  }

  if (sort === "album") {
    return { sort, albumPosition, id: row.id }
  }

  return {
    sort,
    capturedAt: row.captured_at_cursor,
    albumPosition,
    id: row.id,
  }
}

export async function listGalleryPhotos(options: {
  limit: number
  sort: GallerySort
  cursor?: string
}): Promise<{
  photos: GalleryPhoto[]
  total: number
  nextCursor: string | null
  mediaExpiresAt: number
}> {
  const { limit, sort } = options
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_SIZE
  ) {
    throw new RangeError("Invalid gallery page size")
  }
  if (sort !== "album" && sort !== "newest" && sort !== "oldest") {
    throw new TypeError("Invalid gallery sort")
  }

  const cursor =
    options.cursor === undefined
      ? undefined
      : decodeGalleryCursor(options.cursor, sort)
  const sql = database()
  const albumId = galleryAlbumId()
  const signal = AbortSignal.timeout(DATABASE_TIMEOUT_MS)
  const photoQuery = buildPhotoQuery(albumId, sort, cursor, limit + 1)

  const [albumRows, photoRows] = await Promise.all([
    sql.query(
      `
        SELECT photo_count
        FROM wedding_photos.albums
        WHERE id = $1
      `,
      [albumId],
      { fetchOptions: { signal } }
    ) as unknown as Promise<AlbumCountRow[]>,
    sql.query(photoQuery.text, photoQuery.params, {
      fetchOptions: { signal },
    }) as unknown as Promise<GalleryPhotoRow[]>,
  ])

  const total = albumRows.length ? Number(albumRows[0].photo_count) : 0
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Database returned an invalid album photo count")
  }

  const hasMore = photoRows.length > limit
  const visibleRows = hasMore ? photoRows.slice(0, limit) : photoRows
  const lastRow = visibleRows.at(-1)
  const mediaExpiresAt = galleryMediaExpiresAt()

  return {
    photos: visibleRows.map((row) => ({
      id: row.id,
      thumbUrl: createSignedMediaUrlAtExpiry(row.thumb_key, mediaExpiresAt),
      displayUrl: createSignedMediaUrlAtExpiry(
        row.display_key,
        mediaExpiresAt
      ),
      width: Number(row.width),
      height: Number(row.height),
      capturedAt: normalizeCapturedAt(row.captured_at),
      filename: row.original_filename,
      blurDataUrl: row.blur_data_url,
    })),
    total,
    nextCursor:
      hasMore && lastRow
        ? encodeGalleryCursor(rowCursor(lastRow, sort))
        : null,
    mediaExpiresAt,
  }
}
