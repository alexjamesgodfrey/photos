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

export interface GalleryPerson {
  id: string
  slug: string
  displayName: string
  photoCount: number
  avatarUrl: string | null
  avatarWidth: number | null
  avatarHeight: number | null
}

export type GalleryCursor =
  | {
      sort: "album"
      albumPosition: number
      id: string
      person?: string
    }
  | {
      sort: "newest" | "oldest"
      capturedAt: string | null
      albumPosition: number
      id: string
      person?: string
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

interface GalleryPersonRow {
  id: string
  slug: string
  display_name: string
  photo_count: number | string
  avatar_key: string | null
  avatar_width: number | string | null
  avatar_height: number | string | null
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
const MAX_PERSON_SLUG_LENGTH = 128
const PERSON_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const AVATAR_KEY_PATTERN =
  /^wedding\/people\/person_[a-f0-9]{32}\/avatar-[a-f0-9]{20}\.webp$/

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

export function isValidGalleryPersonSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PERSON_SLUG_LENGTH &&
    PERSON_SLUG_PATTERN.test(value)
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
    !validCursorId(cursor.id) ||
    (cursor.person !== undefined &&
      !isValidGalleryPersonSlug(cursor.person))
  ) {
    return invalidCursor()
  }

  const payload =
    cursor.sort === "album"
      ? {
          v: 2,
          s: cursor.sort,
          f: cursor.person ?? null,
          p: cursor.albumPosition,
          i: cursor.id,
        }
      : {
          v: 2,
          s: cursor.sort,
          f: cursor.person ?? null,
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
  expectedSort: GallerySort,
  expectedPerson?: string
): GalleryCursor {
  if (
    expectedPerson !== undefined &&
    !isValidGalleryPersonSlug(expectedPerson)
  ) {
    return invalidCursor()
  }
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

  if (!isRecord(parsed) || parsed.v !== 2 || parsed.s !== expectedSort) {
    return invalidCursor()
  }
  if (!validCursorPosition(parsed.p) || !validCursorId(parsed.i)) {
    return invalidCursor()
  }
  if (
    (parsed.f !== null && !isValidGalleryPersonSlug(parsed.f)) ||
    parsed.f !== (expectedPerson ?? null)
  ) {
    return invalidCursor()
  }

  if (expectedSort === "album") {
    if (!hasExactKeys(parsed, ["v", "s", "f", "p", "i"])) {
      return invalidCursor()
    }
    return {
      sort: "album",
      albumPosition: parsed.p,
      id: parsed.i,
      ...(parsed.f === null ? {} : { person: parsed.f }),
    }
  }

  if (
    !hasExactKeys(parsed, ["v", "s", "f", "t", "p", "i"]) ||
    !validCursorTimestamp(parsed.t)
  ) {
    return invalidCursor()
  }

  return {
    sort: expectedSort,
    capturedAt: parsed.t,
    albumPosition: parsed.p,
    id: parsed.i,
    ...(parsed.f === null ? {} : { person: parsed.f }),
  }
}

function appendPersonPhotoFilter(
  person: string | undefined,
  params: Array<string | number>
): string {
  if (!person) return ""
  params.push(person)
  const personParameter = `$${params.length}`
  return `
    AND EXISTS (
      SELECT 1
      FROM wedding_photos.photo_people pp
      JOIN wedding_photos.people pe ON pe.id = pp.person_id
      WHERE pp.photo_id = ph.id
        AND pe.album_id = ph.album_id
        AND pe.slug = ${personParameter}
    )
  `
}

function buildPhotoCountQuery(
  albumId: string,
  person: string | undefined
): PhotoQuery {
  if (!person) {
    return {
      text: `
        SELECT photo_count
        FROM wedding_photos.albums
        WHERE id = $1
      `,
      params: [albumId],
    }
  }

  const params: Array<string | number> = [albumId]
  const personFilter = appendPersonPhotoFilter(person, params)
  return {
    text: `
      SELECT count(*) AS photo_count
      FROM wedding_photos.photos ph
      WHERE ph.album_id = $1
        AND ph.published = true
        ${personFilter}
    `,
    params,
  }
}

function buildPhotoQuery(
  albumId: string,
  sort: GallerySort,
  person: string | undefined,
  cursor: GalleryCursor | undefined,
  requestedRows: number
): PhotoQuery {
  const params: Array<string | number> = [albumId]
  const personFilter = appendPersonPhotoFilter(person, params)
  const addParameter = (value: string | number) => {
    params.push(value)
    return `$${params.length}`
  }
  const select = `
    SELECT
      ph.id,
      ph.original_filename,
      ph.captured_at,
      to_char(
        ph.captured_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS captured_at_cursor,
      ph.album_position,
      ph.width,
      ph.height,
      ph.thumb_key,
      ph.display_key,
      ph.blur_data_url
    FROM wedding_photos.photos ph
    WHERE ph.album_id = $1 AND ph.published = true
      ${personFilter}
  `

  if (sort === "album") {
    if (!cursor) {
      const limitParameter = addParameter(requestedRows)
      return {
        text: `${select}
          ORDER BY ph.album_position ASC, ph.id ASC
          LIMIT ${limitParameter}
        `,
        params,
      }
    }

    const positionParameter = addParameter(cursor.albumPosition)
    const idParameter = addParameter(cursor.id)
    const limitParameter = addParameter(requestedRows)
    return {
      text: `${select}
        AND (ph.album_position, ph.id) > (${positionParameter}, ${idParameter})
        ORDER BY ph.album_position ASC, ph.id ASC
        LIMIT ${limitParameter}
      `,
      params,
    }
  }

  const orderDirection = sort === "newest" ? "DESC" : "ASC"
  const comparison = sort === "newest" ? "<" : ">"

  if (!cursor) {
    const limitParameter = addParameter(requestedRows)
    return {
      text: `${select}
        ORDER BY ph.captured_at ${orderDirection} NULLS LAST,
                 ph.album_position ASC,
                 ph.id ASC
        LIMIT ${limitParameter}
      `,
      params,
    }
  }

  if (cursor.sort === "album") {
    return invalidCursor()
  }

  if (cursor.capturedAt === null) {
    const positionParameter = addParameter(cursor.albumPosition)
    const idParameter = addParameter(cursor.id)
    const limitParameter = addParameter(requestedRows)
    return {
      text: `${select}
        AND ph.captured_at IS NULL
        AND (ph.album_position, ph.id) > (${positionParameter}, ${idParameter})
        ORDER BY ph.captured_at ${orderDirection} NULLS LAST,
                 ph.album_position ASC,
                 ph.id ASC
        LIMIT ${limitParameter}
      `,
      params,
    }
  }

  const capturedAtParameter = addParameter(cursor.capturedAt)
  const positionParameter = addParameter(cursor.albumPosition)
  const idParameter = addParameter(cursor.id)
  const limitParameter = addParameter(requestedRows)
  return {
    text: `${select}
      AND (
        ph.captured_at IS NULL
        OR ph.captured_at ${comparison} ${capturedAtParameter}::timestamptz
        OR (
          ph.captured_at = ${capturedAtParameter}::timestamptz
          AND (ph.album_position, ph.id) > (${positionParameter}, ${idParameter})
        )
      )
      ORDER BY ph.captured_at ${orderDirection} NULLS LAST,
               ph.album_position ASC,
               ph.id ASC
      LIMIT ${limitParameter}
    `,
    params,
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

function rowCursor(
  row: GalleryPhotoRow,
  sort: GallerySort,
  person: string | undefined
): GalleryCursor {
  const albumPosition = Number(row.album_position)
  if (!validCursorPosition(albumPosition)) {
    throw new Error("Database returned an invalid album position")
  }

  if (sort === "album") {
    return {
      sort,
      albumPosition,
      id: row.id,
      ...(person ? { person } : {}),
    }
  }

  return {
    sort,
    capturedAt: row.captured_at_cursor,
    albumPosition,
    id: row.id,
    ...(person ? { person } : {}),
  }
}

export async function listGalleryPhotos(options: {
  limit: number
  sort: GallerySort
  cursor?: string
  person?: string
}): Promise<{
  photos: GalleryPhoto[]
  total: number
  nextCursor: string | null
  mediaExpiresAt: number
}> {
  const { limit, sort, person } = options
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
  if (person !== undefined && !isValidGalleryPersonSlug(person)) {
    throw new TypeError("Invalid gallery person slug")
  }

  const cursor =
    options.cursor === undefined
      ? undefined
      : decodeGalleryCursor(options.cursor, sort, person)
  const sql = database()
  const albumId = galleryAlbumId()
  const signal = AbortSignal.timeout(DATABASE_TIMEOUT_MS)
  const countQuery = buildPhotoCountQuery(albumId, person)
  const photoQuery = buildPhotoQuery(
    albumId,
    sort,
    person,
    cursor,
    limit + 1
  )

  const [albumRows, photoRows] = await Promise.all([
    sql.query(countQuery.text, countQuery.params, {
      fetchOptions: { signal },
    }) as unknown as Promise<AlbumCountRow[]>,
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
        ? encodeGalleryCursor(rowCursor(lastRow, sort, person))
        : null,
    mediaExpiresAt,
  }
}

export async function listGalleryPeople(): Promise<{
  people: GalleryPerson[]
  mediaExpiresAt: number
}> {
  const sql = database()
  const albumId = galleryAlbumId()
  const signal = AbortSignal.timeout(DATABASE_TIMEOUT_MS)
  const rows = (await sql.query(
    `
      SELECT
        pe.id,
        pe.slug,
        pe.display_name,
        pe.avatar_key,
        pe.avatar_width,
        pe.avatar_height,
        count(pp.photo_id) AS photo_count
      FROM wedding_photos.people pe
      JOIN wedding_photos.photo_people pp ON pp.person_id = pe.id
      JOIN wedding_photos.photos ph
        ON ph.id = pp.photo_id
        AND ph.album_id = pe.album_id
        AND ph.published = true
      WHERE pe.album_id = $1
      GROUP BY
        pe.id,
        pe.slug,
        pe.display_name,
        pe.avatar_key,
        pe.avatar_width,
        pe.avatar_height
      ORDER BY lower(pe.display_name) ASC, pe.display_name ASC, pe.id ASC
    `,
    [albumId],
    { fetchOptions: { signal } }
  )) as unknown as GalleryPersonRow[]
  const mediaExpiresAt = galleryMediaExpiresAt()

  return {
    people: rows.map((row) => {
      if (
        !validCursorId(row.id) ||
        !isValidGalleryPersonSlug(row.slug) ||
        typeof row.display_name !== "string" ||
        row.display_name.trim().length === 0
      ) {
        throw new Error("Database returned an invalid gallery person")
      }

      const photoCount = Number(row.photo_count)
      if (!Number.isSafeInteger(photoCount) || photoCount < 1) {
        throw new Error("Database returned an invalid person photo count")
      }

      const hasAvatar = row.avatar_key !== null
      const avatarWidth =
        row.avatar_width === null ? null : Number(row.avatar_width)
      const avatarHeight =
        row.avatar_height === null ? null : Number(row.avatar_height)
      const validAvatar =
        hasAvatar &&
        typeof row.avatar_key === "string" &&
        AVATAR_KEY_PATTERN.test(row.avatar_key) &&
        row.avatar_key.split("/")[2] === row.id &&
        avatarWidth !== null &&
        Number.isSafeInteger(avatarWidth) &&
        avatarWidth > 0 &&
        avatarHeight !== null &&
        Number.isSafeInteger(avatarHeight) &&
        avatarHeight > 0
      const noAvatar =
        !hasAvatar && avatarWidth === null && avatarHeight === null
      if (!validAvatar && !noAvatar) {
        throw new Error("Database returned invalid person avatar metadata")
      }

      return {
        id: row.id,
        slug: row.slug,
        displayName: row.display_name,
        photoCount,
        avatarUrl:
          row.avatar_key === null
            ? null
            : createSignedMediaUrlAtExpiry(
                row.avatar_key,
                mediaExpiresAt
              ),
        avatarWidth,
        avatarHeight,
      }
    }),
    mediaExpiresAt,
  }
}
