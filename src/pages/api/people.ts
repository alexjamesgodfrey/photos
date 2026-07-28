import { listGalleryPeople } from "@/lib/gallery-db"
import { hasGallerySession } from "@/lib/gallery-session"
import type { NextApiRequest, NextApiResponse } from "next"

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

  try {
    const result = await listGalleryPeople()
    return response.status(200).json(result)
  } catch (error) {
    console.error("Unable to load gallery people", error)
    return response.status(503).json({ error: "Unable to load people" })
  }
}
