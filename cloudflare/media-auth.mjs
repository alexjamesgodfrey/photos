const textEncoder = new TextEncoder()

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value")
  }

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  )
}

export async function getValidSignedUrlExpiration(
  url,
  secret,
  now = Date.now()
) {
  if (!secret || secret.length < 32) return null

  const expiresValue = url.searchParams.get("expires")
  const signatureValue = url.searchParams.get("signature")
  if (
    !expiresValue ||
    !signatureValue ||
    !/^[1-9]\d*$/.test(expiresValue) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signatureValue)
  ) {
    return null
  }

  const expires = Number(expiresValue)
  if (
    !Number.isSafeInteger(expires) ||
    String(expires) !== expiresValue ||
    expires <= now / 1000
  ) {
    return null
  }

  let signature
  try {
    signature = decodeBase64Url(signatureValue)
  } catch {
    return null
  }

  const encodedPath = url.pathname.replace(/^\/+/, "")
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    textEncoder.encode(`media:${encodedPath}:${expiresValue}`)
  )

  return valid ? expires : null
}

export async function hasValidSignedUrl(url, secret, now = Date.now()) {
  return (await getValidSignedUrlExpiration(url, secret, now)) !== null
}
