import { clearGallerySessionCookie } from "@/lib/gallery-session"
import type { NextApiRequest, NextApiResponse } from "next"

export default function handler(
  request: NextApiRequest,
  response: NextApiResponse
) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0")

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST")
    return response.status(405).json({ error: "Method not allowed" })
  }

  response.setHeader("Set-Cookie", clearGallerySessionCookie())
  return response.status(204).end()
}
