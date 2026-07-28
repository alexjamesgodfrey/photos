import {
  InvalidGalleryCursorError,
  isValidGalleryPersonSlug,
  listGalleryPhotos,
  type GallerySort,
} from "@/lib/gallery-db"
import { hasGallerySession } from "@/lib/gallery-session"
import type { NextApiRequest, NextApiResponse } from "next"

const DEFAULT_PAGE_SIZE = 60
const MAX_PAGE_SIZE = 120
const VALID_SORTS = new Set<GallerySort>(["album", "newest", "oldest"])

function singleQueryValue(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? undefined : value
}

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse
) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0")

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET")
    return response.status(405).json({ error: "Method not allowed" })
  }

  try {
    if (!hasGallerySession(request)) {
      return response.status(401).json({ error: "Authentication required" })
    }
  } catch (error) {
    console.error("Unable to verify gallery session", error)
    return response.status(503).json({ error: "Gallery is not configured" })
  }

  const limitValue = singleQueryValue(request.query.limit)
  if (Array.isArray(request.query.limit)) {
    return response.status(400).json({ error: "Invalid limit" })
  }
  const requestedLimit = Number(limitValue)
  const limit =
    Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE

  if (Array.isArray(request.query.cursor)) {
    return response.status(400).json({ error: "Invalid cursor" })
  }
  const cursor = singleQueryValue(request.query.cursor)

  const requestedSort = singleQueryValue(request.query.sort) as
    | GallerySort
    | undefined
  const sort =
    requestedSort && VALID_SORTS.has(requestedSort)
      ? requestedSort
      : "album"

  if (Array.isArray(request.query.person)) {
    return response.status(400).json({ error: "Invalid person" })
  }
  const person = singleQueryValue(request.query.person)
  if (person !== undefined && !isValidGalleryPersonSlug(person)) {
    return response.status(400).json({ error: "Invalid person" })
  }

  try {
    const result = await listGalleryPhotos({ limit, sort, cursor, person })
    return response.status(200).json(result)
  } catch (error) {
    if (error instanceof InvalidGalleryCursorError) {
      return response.status(400).json({ error: "Invalid cursor" })
    }
    console.error("Unable to load gallery photos", error)
    return response.status(503).json({ error: "Unable to load photos" })
  }
}
