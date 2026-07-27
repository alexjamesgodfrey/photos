#!/usr/bin/env node

import { randomBytes } from "node:crypto"
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises"
import { createReadStream } from "node:fs"
import http from "node:http"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createFaceStore } from "./store.mjs"

const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TOOL_DIRECTORY, "../..")
const DEFAULT_WORKSPACE = path.join(REPO_ROOT, ".media-staging", "faces")
const PUBLIC_DIRECTORY = path.join(TOOL_DIRECTORY, "public")
const MAX_JSON_BYTES = 64 * 1024

const STATIC_FILES = new Map([
  ["/app.js", { filename: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { filename: "styles.css", type: "text/css; charset=utf-8" }],
])

export async function startFaceLabelerServer(options = {}) {
  const workspace = path.resolve(options.workspace ?? DEFAULT_WORKSPACE)
  const objectsDirectory = path.resolve(
    options.objectsDirectory
      ?? path.join(REPO_ROOT, ".media-staging", "web", "objects")
  )
  assertWorkspace(workspace)
  const databasePath = path.join(workspace, "faces.sqlite3")
  const databaseStat = await stat(databasePath).catch(() => null)
  if (!databaseStat?.isFile()) {
    throw new Error("Face database is missing; run npm run faces:analyze first")
  }
  await chmod(workspace, 0o700)
  await chmod(databasePath, 0o600)

  const store = createFaceStore(databasePath)
  if (options.backup !== false) {
    await createBackup(store, workspace, databasePath)
  }

  const csrfToken = randomBytes(32).toString("base64url")
  const sessionToken = randomBytes(32).toString("base64url")
  const indexTemplate = await readFile(
    path.join(PUBLIC_DIRECTORY, "index.html"),
    "utf8"
  )
  if (!indexTemplate.includes("__FACE_LABELER_CSRF__")) {
    store.close()
    throw new Error("Labeler HTML is missing its CSRF placeholder")
  }
  const indexHtml = indexTemplate.replaceAll(
    "__FACE_LABELER_CSRF__",
    csrfToken
  )

  const server = http.createServer((request, response) => {
    handleRequest({
      request,
      response,
      server,
      store,
      workspace,
      objectsDirectory,
      indexHtml,
      csrfToken,
      sessionToken,
    }).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, error.statusCode ?? 500, {
          error:
            error.statusCode && error.statusCode < 500
              ? error.message
              : "The local labeler encountered an error.",
        })
      } else {
        response.destroy()
      }
      if (!error.statusCode || error.statusCode >= 500) {
        console.error(error)
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(
      {
        host: "127.0.0.1",
        port: options.port ?? 4177,
        exclusive: true,
      },
      resolve
    )
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : options.port
  const origin = `http://127.0.0.1:${port}`

  return {
    origin,
    port,
    close: async () => {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      store.checkpoint()
      store.close()
    },
  }
}

async function handleRequest(context) {
  const {
    request,
    response,
    server,
    store,
    workspace,
    objectsDirectory,
  } = context
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 4177
  const expectedHost = `127.0.0.1:${port}`
  const expectedOrigin = `http://${expectedHost}`
  if (request.headers.host !== expectedHost) {
    return sendJson(response, 421, { error: "Invalid local host." })
  }

  const url = new URL(request.url ?? "/", expectedOrigin)
  const method = request.method ?? "GET"
  if (method === "OPTIONS") {
    response.setHeader("Allow", "GET, POST")
    return sendJson(response, 405, { error: "Method not allowed." })
  }
  const hasSession = parseCookies(request.headers.cookie).face_labeler_session
    === context.sessionToken
  if (!hasSession) {
    if (method === "GET" && url.pathname === "/") {
      response.statusCode = 303
      setSecurityHeaders(response)
      response.setHeader(
        "Set-Cookie",
        `face_labeler_session=${context.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`
      )
      response.setHeader("Location", "/")
      return response.end()
    }
    return sendJson(response, 401, { error: "Local session required." })
  }

  if (method === "POST") {
    if (request.headers.origin !== expectedOrigin) {
      return sendJson(response, 403, { error: "Invalid request origin." })
    }
    if (request.headers["x-face-labeler-csrf"] !== context.csrfToken) {
      return sendJson(response, 403, { error: "Invalid CSRF token." })
    }
  }

  if (method === "GET" && url.pathname === "/") {
    return send(response, 200, context.indexHtml, "text/html; charset=utf-8")
  }
  if (method === "GET" && STATIC_FILES.has(url.pathname)) {
    const asset = STATIC_FILES.get(url.pathname)
    const body = await readFile(path.join(PUBLIC_DIRECTORY, asset.filename))
    return send(response, 200, body, asset.type)
  }
  if (method === "GET" && url.pathname === "/favicon.ico") {
    response.statusCode = 204
    setSecurityHeaders(response)
    return response.end()
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(
      response,
      200,
      store.bootstrap({
        status: url.searchParams.get("status") ?? "unreviewed",
        query: url.searchParams.get("query") ?? "",
      })
    )
  }
  if (method === "GET" && url.pathname === "/api/export-preview") {
    return sendJson(response, 200, store.exportPreview())
  }

  let match = url.pathname.match(/^\/api\/clusters\/([^/]+)$/)
  if (method === "GET" && match) {
    const cluster = store.cluster(decodeURIComponent(match[1]))
    return cluster
      ? sendJson(response, 200, cluster)
      : sendJson(response, 404, { error: "Cluster not found." })
  }
  match = url.pathname.match(/^\/media\/crop\/([^/]+)$/)
  if (method === "GET" && match) {
    const row = store.crop(decodeURIComponent(match[1]))
    if (!row) return sendJson(response, 404, { error: "Face not found." })
    const filename = safeChild(workspace, row.crop_relpath)
    return streamFile(response, filename, "image/webp")
  }
  match = url.pathname.match(/^\/media\/photo\/([^/]+)$/)
  if (method === "GET" && match) {
    const row = store.photo(decodeURIComponent(match[1]))
    if (!row) return sendJson(response, 404, { error: "Photo not found." })
    if (!row.display_relpath.startsWith("web/objects/")) {
      throw new Error("Invalid display media path")
    }
    const relative = row.display_relpath.replace(/^web\/objects\//, "")
    const filename = safeChild(objectsDirectory, relative)
    return streamFile(response, filename, "image/webp")
  }

  if (method === "POST" && url.pathname === "/api/clusters/merge") {
    const body = await readJson(request)
    return sendJson(response, 200, store.mergeClusters(body))
  }
  if (
    method === "POST"
    && url.pathname === "/api/clusters/batch-label"
  ) {
    const body = await readJson(request)
    return sendJson(response, 200, store.batchLabelClusters(body))
  }
  if (
    method === "POST"
    && (url.pathname === "/api/undo" || url.pathname === "/api/actions/undo")
  ) {
    await readJson(request, { allowEmpty: true })
    return sendJson(response, 200, store.undo())
  }

  match = url.pathname.match(
    /^\/api\/clusters\/([^/]+)\/(label|ignore|unknown|unignore|split)$/
  )
  if (method === "POST" && match) {
    const [, rawId, action] = match
    const clusterId = decodeURIComponent(rawId)
    const body = await readJson(request, { allowEmpty: action !== "label" && action !== "split" })
    if (action === "label") {
      return sendJson(response, 200, store.labelCluster(clusterId, body))
    }
    if (action === "split") {
      return sendJson(response, 200, store.splitCluster(clusterId, body))
    }
    const state =
      action === "unignore"
        ? "unreviewed"
        : action === "ignore"
          ? "ignored"
          : action
    return sendJson(
      response,
      200,
      store.dispositionCluster(clusterId, state, body)
    )
  }

  match = url.pathname.match(
    /^\/api\/faces\/([^/]+)\/(ignore|unknown|unignore)$/
  )
  if (method === "POST" && match) {
    const [, rawId, action] = match
    const body = await readJson(request, { allowEmpty: true })
    const state =
      action === "unignore"
        ? "unreviewed"
        : action === "ignore"
          ? "ignored"
          : action
    return sendJson(
      response,
      200,
      store.dispositionFace(decodeURIComponent(rawId), state, body)
    )
  }

  return sendJson(response, 404, { error: "Not found." })
}

async function readJson(request, options = {}) {
  const contentType = request.headers["content-type"] ?? ""
  const length = Number(request.headers["content-length"] ?? 0)
  if (length > MAX_JSON_BYTES) {
    const error = new Error("Request body is too large.")
    error.statusCode = 413
    throw error
  }
  if (length > 0 && !String(contentType).toLowerCase().startsWith("application/json")) {
    const error = new Error("Expected application/json.")
    error.statusCode = 415
    throw error
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_JSON_BYTES) {
      const error = new Error("Request body is too large.")
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (!bytes) {
    if (options.allowEmpty) return {}
    const error = new Error("JSON body is required.")
    error.statusCode = 400
    throw error
  }
  if (!String(contentType).toLowerCase().startsWith("application/json")) {
    const error = new Error("Expected application/json.")
    error.statusCode = 415
    throw error
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("Expected a JSON object")
    }
    return value
  } catch {
    const error = new Error("Invalid JSON body.")
    error.statusCode = 400
    throw error
  }
}

async function streamFile(response, filename, contentType) {
  const fileStat = await stat(filename).catch(() => null)
  if (!fileStat?.isFile()) {
    return sendJson(response, 404, { error: "Image not found." })
  }
  response.statusCode = 200
  setSecurityHeaders(response)
  response.setHeader("Content-Type", contentType)
  response.setHeader("Content-Length", fileStat.size)
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin")
  const stream = createReadStream(filename)
  stream.once("error", () => response.destroy())
  stream.pipe(response)
}

function sendJson(response, status, value) {
  return send(
    response,
    status,
    JSON.stringify(value),
    "application/json; charset=utf-8"
  )
}

function send(response, status, body, contentType) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body)
  response.statusCode = status
  setSecurityHeaders(response)
  response.setHeader("Content-Type", contentType)
  response.setHeader("Content-Length", payload.byteLength)
  response.end(payload)
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0")
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; "
      + "img-src 'self' blob: data:; connect-src 'self'; "
      + "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  )
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin")
  response.setHeader("Referrer-Policy", "no-referrer")
  response.setHeader("X-Content-Type-Options", "nosniff")
  response.setHeader("X-Frame-Options", "DENY")
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive")
}

function parseCookies(header = "") {
  const cookies = {}
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=")
    if (separator === -1) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (key) cookies[key] = value
  }
  return cookies
}

function safeChild(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) {
    throw new Error("Invalid local media path")
  }
  const candidate = path.resolve(root, relative)
  const relation = path.relative(path.resolve(root), candidate)
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error("Local media path escaped its allowlisted directory")
  }
  return candidate
}

function assertWorkspace(workspace) {
  const allowedRoot = path.join(REPO_ROOT, ".media-staging")
  const relation = path.relative(allowedRoot, workspace)
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error("Workspace must be inside the ignored .media-staging directory")
  }
}

async function createBackup(store, workspace, databasePath) {
  store.checkpoint()
  const backupDirectory = path.join(workspace, "backups")
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
  await chmod(backupDirectory, 0o700)
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  const destination = path.join(backupDirectory, `faces-${stamp}.sqlite3`)
  await copyFile(databasePath, destination)
  await chmod(destination, 0o600)
  const backups = (await readdir(backupDirectory))
    .filter((filename) => /^faces-.*\.sqlite3$/.test(filename))
    .sort()
  for (const filename of backups.slice(0, -10)) {
    await rm(path.join(backupDirectory, filename), { force: true })
  }
}

function parseArguments(arguments_) {
  const options = {
    workspace: DEFAULT_WORKSPACE,
    objectsDirectory: path.join(
      REPO_ROOT,
      ".media-staging",
      "web",
      "objects"
    ),
    port: 4177,
  }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--workspace") {
      options.workspace = arguments_[index + 1]
      index += 1
    } else if (argument === "--objects-dir") {
      options.objectsDirectory = arguments_[index + 1]
      index += 1
    } else if (argument === "--port") {
      options.port = Number(arguments_[index + 1])
      index += 1
      if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) {
        throw new Error("--port must be between 0 and 65535")
      }
    } else if (argument === "--help") {
      console.log(
        "Usage: npm run faces:label -- "
          + "[--workspace PATH] [--objects-dir PATH] [--port PORT]"
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const options = parseArguments(process.argv.slice(2))
  const instance = await startFaceLabelerServer(options).catch((error) => {
    console.error(`Unable to start face labeler: ${error.message}`)
    process.exit(1)
  })
  console.log(`Face labeler ready at ${instance.origin}`)
  console.log("Biometric artifacts remain local under .media-staging/faces.")
  const stop = async () => {
    await instance.close()
    process.exit(0)
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}
