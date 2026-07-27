import {
  createGallerySessionCookie,
  isGalleryAccessCodeValid,
} from "@/lib/gallery-session"
import type { NextApiRequest, NextApiResponse } from "next"

const INVALID_CODE_DELAY_MS = 650

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1kb",
    },
  },
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse
) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0")

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST")
    return response.status(405).json({ error: "Method not allowed" })
  }

  const code =
    typeof request.body?.code === "string" ? request.body.code.trim() : ""

  if (!code || code.length > 128) {
    await delay(INVALID_CODE_DELAY_MS)
    return response.status(401).json({ error: "That access code is not valid." })
  }

  try {
    if (!isGalleryAccessCodeValid(code)) {
      await delay(INVALID_CODE_DELAY_MS)
      return response
        .status(401)
        .json({ error: "That access code is not valid." })
    }

    response.setHeader("Set-Cookie", createGallerySessionCookie())
    return response.status(204).end()
  } catch (error) {
    console.error("Gallery authentication is not configured", error)
    return response
      .status(503)
      .json({ error: "The gallery is being prepared. Please try again soon." })
  }
}
