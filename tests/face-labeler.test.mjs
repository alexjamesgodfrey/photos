import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"

import { startFaceLabelerServer } from "../tools/face-labeler/server.mjs"

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const TEST_ROOT = path.join(
  REPO_ROOT,
  ".media-staging",
  "face-labeler-test-temp"
)
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  "tools",
  "face-labeler",
  "schema.sql"
)
const NOW = "2026-07-27T12:00:00.000Z"
const SUITE = "face-labeler-real-service"

function structuredLog(testName, phase, event, data = {}) {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      suite: SUITE,
      test: testName,
      phase,
      event,
      data,
    })}\n`
  )
}

function assertExactTestRoot() {
  const expected = path.resolve(
    REPO_ROOT,
    ".media-staging",
    "face-labeler-test-temp"
  )
  assert.equal(path.resolve(TEST_ROOT), expected)
  assert.equal(path.dirname(TEST_ROOT), path.join(REPO_ROOT, ".media-staging"))
}

function assertTestWorkspace(workspace) {
  assertExactTestRoot()
  const relation = path.relative(TEST_ROOT, path.resolve(workspace))
  assert.ok(relation)
  assert.equal(relation.startsWith(".."), false)
  assert.equal(path.isAbsolute(relation), false)
}

async function removeTestRoot() {
  assertExactTestRoot()
  await rm(TEST_ROOT, { recursive: true, force: true })
}

before(async () => {
  await removeTestRoot()
  await mkdir(TEST_ROOT, { recursive: true, mode: 0o700 })
})

after(async () => {
  await removeTestRoot()
  assert.equal(await stat(TEST_ROOT).catch(() => null), null)
})

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

function fixtureId(prefix, runKey, label) {
  return `${prefix}_${digest(`${runKey}:${label}`).slice(0, 32)}`
}

function mutationId(label) {
  return `test_${label}_${randomUUID().replaceAll("-", "")}`
}

function makeCrop(faceId) {
  return Buffer.from(
    `RIFF-test-WEBP-face-labeler-${faceId}`,
    "utf8"
  )
}

function makeDisplay(photoId) {
  return Buffer.from(
    `RIFF-test-WEBP-face-labeler-display-${photoId}`,
    "utf8"
  )
}

async function initializeDatabase(workspace) {
  const schema = await readFile(SCHEMA_PATH, "utf8")
  const databasePath = path.join(workspace, "faces.sqlite3")
  const cropsDirectory = path.join(workspace, "crops")
  const objectsDirectory = path.join(workspace, "objects")
  const runKey = randomUUID()
  await mkdir(cropsDirectory, { recursive: true, mode: 0o700 })
  await mkdir(objectsDirectory, { recursive: true, mode: 0o700 })

  const photos = Object.fromEntries(
    [
      "label",
      "split_a",
      "split_b",
      "merge_a",
      "merge_b",
      "blocked_shared",
      "state_a",
      "state_b",
    ].map((label, index) => [
      label,
      {
        id: fixtureId("p", runKey, `photo:${label}`),
        albumPosition: index + 1,
      },
    ])
  )
  const clusters = Object.fromEntries(
    [
      "label",
      "split",
      "merge_a",
      "merge_b",
      "blocked_a",
      "blocked_b",
      "state",
    ].map((label) => [
      label,
      fixtureId("c", runKey, `cluster:${label}`),
    ])
  )
  const faceSpecs = [
    ["label", "label", "label", 0],
    ["split_a", "split", "split_a", 0],
    ["split_b", "split", "split_b", 0],
    ["merge_a", "merge_a", "merge_a", 0],
    ["merge_b", "merge_b", "merge_b", 0],
    ["blocked_a", "blocked_a", "blocked_shared", 0],
    ["blocked_b", "blocked_b", "blocked_shared", 1],
    ["state_a", "state", "state_a", 0],
    ["state_b", "state", "state_b", 0],
  ]
  const faces = {}

  const database = new DatabaseSync(databasePath)
  try {
    database.exec(schema)
    database
      .prepare(
        `INSERT INTO workspace (
          id, schema_version, album_id, source_manifest_sha256,
          detector_sha256, embedder_sha256, pipeline_version, config_json,
          created_at, updated_at
        ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "test-wedding",
        digest(`${runKey}:manifest`),
        digest(`${runKey}:detector`),
        digest(`${runKey}:embedder`),
        "test-real-service-v1",
        JSON.stringify({ testFixture: true }),
        NOW,
        NOW
      )

    const insertPhoto = database.prepare(
      `INSERT INTO photos (
        id, album_position, source_fingerprint, display_relpath,
        display_sha256, width, height, scan_key, scan_status,
        attempt_count, face_count, processed_at
      ) VALUES (?, ?, ?, ?, ?, 2400, 1600, ?, 'complete', 1, 0, ?)`
    )
    for (const [label, photo] of Object.entries(photos)) {
      const objectRelativePath = path.join(
        "test",
        photo.id,
        "display.webp"
      )
      const display = makeDisplay(photo.id)
      const displayRelpath = `web/objects/${objectRelativePath}`
      await mkdir(
        path.dirname(path.join(objectsDirectory, objectRelativePath)),
        { recursive: true, mode: 0o700 }
      )
      await writeFile(
        path.join(objectsDirectory, objectRelativePath),
        display,
        { mode: 0o600 }
      )
      photo.display = display
      photo.displayRelpath = displayRelpath
      insertPhoto.run(
        photo.id,
        photo.albumPosition,
        digest(`${runKey}:source:${label}`),
        displayRelpath,
        digest(`${runKey}:display:${label}`),
        digest(`${runKey}:scan:${label}`),
        NOW
      )
    }

    const insertCluster = database.prepare(
      `INSERT INTO clusters (
        id, origin, status, created_at, updated_at
      ) VALUES (?, 'automatic', 'unreviewed', ?, ?)`
    )
    for (const clusterId of Object.values(clusters)) {
      insertCluster.run(clusterId, NOW, NOW)
    }

    const insertFace = database.prepare(
      `INSERT INTO faces (
        id, photo_id, cluster_id, ordinal,
        bbox_x, bbox_y, bbox_width, bbox_height, landmarks_json,
        detection_score, width_px, height_px, quality, quality_score,
        crop_relpath, crop_sha256, status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        0.15, 0.2, 0.3, 0.4, '{}',
        ?, 320, 320, 'clusterable', ?,
        ?, ?, 'unreviewed', ?, ?
      )`
    )

    for (const [
      faceLabel,
      clusterLabel,
      photoLabel,
      ordinal,
    ] of faceSpecs) {
      const faceId = fixtureId("f", runKey, `face:${faceLabel}`)
      const cropRelpath = path.join(
        "crops",
        faceId.slice(0, 4),
        `${faceId}.webp`
      )
      const crop = makeCrop(faceId)
      const quality = 0.7 + Object.keys(faces).length * 0.02
      insertFace.run(
        faceId,
        photos[photoLabel].id,
        clusters[clusterLabel],
        ordinal,
        0.9,
        quality,
        cropRelpath,
        digest(crop),
        NOW,
        NOW
      )
      await mkdir(path.dirname(path.join(workspace, cropRelpath)), {
        recursive: true,
        mode: 0o700,
      })
      await writeFile(path.join(workspace, cropRelpath), crop, {
        mode: 0o600,
      })
      faces[faceLabel] = {
        id: faceId,
        crop,
        photoId: photos[photoLabel].id,
      }
    }

    const updateRepresentative = database.prepare(
      `UPDATE clusters
       SET representative_face_id=(
         SELECT id FROM faces
         WHERE cluster_id=clusters.id
         ORDER BY quality_score DESC, id
         LIMIT 1
       )
       WHERE id=?`
    )
    for (const clusterId of Object.values(clusters)) {
      updateRepresentative.run(clusterId)
    }
    database.exec(
      `UPDATE photos
       SET face_count=(
         SELECT count(*) FROM faces WHERE photo_id=photos.id
       )`
    )

    const [blockedFaceA, blockedFaceB] = [
      faces.blocked_a.id,
      faces.blocked_b.id,
    ].sort()
    database
      .prepare(
        `INSERT INTO cannot_links (
          face_id_a, face_id_b, reason, created_at
        ) VALUES (?, ?, 'same_photo', ?)`
      )
      .run(blockedFaceA, blockedFaceB, NOW)

    const [suggestedClusterA, suggestedClusterB] = [
      clusters.merge_a,
      clusters.merge_b,
    ].sort()
    database
      .prepare(
        `INSERT INTO cluster_suggestions (
          cluster_id_a, cluster_id_b,
          similarity_max, similarity_median, similarity_min,
          status, created_at
        ) VALUES (?, ?, 0.94, 0.91, 0.87, 'pending', ?)`
      )
      .run(suggestedClusterA, suggestedClusterB, NOW)

    const [splitSuggestionA, splitSuggestionB] = [
      clusters.split,
      clusters.label,
    ].sort()
    database
      .prepare(
        `INSERT INTO cluster_suggestions (
          cluster_id_a, cluster_id_b,
          similarity_max, similarity_median, similarity_min,
          status, created_at
        ) VALUES (?, ?, 0.83, 0.79, 0.73, 'rejected', ?)`
      )
      .run(splitSuggestionA, splitSuggestionB, NOW)
  } finally {
    database.close()
  }

  return {
    databasePath,
    cropsDirectory,
    objectsDirectory,
    fixtures: { photos, clusters, faces },
  }
}

async function createHarness(testName) {
  const prefix = `${testName.replace(/[^a-z0-9]+/gi, "-").slice(0, 32)}-`
  const workspace = await mkdtemp(path.join(TEST_ROOT, prefix))
  assertTestWorkspace(workspace)

  let server
  try {
    const initialized = await initializeDatabase(workspace)
    server = await startFaceLabelerServer({
      workspace,
      objectsDirectory: initialized.objectsDirectory,
      port: 0,
      backup: true,
    })
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    return {
      ...initialized,
      ...server,
      workspace,
      sessionCookie: null,
      csrfToken: null,
      closed: false,
      async close() {
        if (this.closed) return
        this.closed = true
        await server.close()
        assertTestWorkspace(workspace)
        await rm(workspace, { recursive: true, force: true })
        assert.equal(await stat(workspace).catch(() => null), null)
      },
    }
  } catch (error) {
    if (server) await server.close().catch(() => undefined)
    assertTestWorkspace(workspace)
    await rm(workspace, { recursive: true, force: true })
    throw error
  }
}

async function withHarness(testName, operation) {
  const startedAt = performance.now()
  structuredLog(testName, "setup", "test_start")
  const harness = await createHarness(testName)
  structuredLog(testName, "setup", "service_ready", {
    host: "127.0.0.1",
    port: harness.port,
  })

  let result = "pass"
  try {
    await operation(harness)
  } catch (error) {
    result = "fail"
    structuredLog(testName, "assert", "failure", {
      name: error?.name,
      message: error?.message,
    })
    throw error
  } finally {
    structuredLog(testName, "teardown", "cleanup_start")
    await harness.close()
    structuredLog(testName, "teardown", "test_end", {
      result,
      durationMs: Math.round(performance.now() - startedAt),
      workspaceRemoved: true,
    })
  }
}

function localUrl(harness, pathname) {
  assert.equal(typeof pathname, "string")
  assert.equal(pathname.startsWith("/"), true)
  const url = new URL(pathname, harness.origin)
  assert.equal(url.origin, harness.origin)
  assert.equal(url.hostname, "127.0.0.1")
  return url
}

function localFetch(harness, pathname, options = {}) {
  return fetch(localUrl(harness, pathname), {
    redirect: "manual",
    ...options,
  })
}

async function establishSession(harness) {
  const start = await localFetch(harness, "/")
  assert.equal(start.status, 303)
  assert.equal(start.headers.get("location"), "/")
  const setCookie = start.headers.get("set-cookie")
  assert.ok(setCookie)
  assert.match(setCookie, /^face_labeler_session=[A-Za-z0-9_-]+;/)
  assert.match(setCookie, /;\s*HttpOnly/i)
  assert.match(setCookie, /;\s*SameSite=Strict/i)
  assert.match(setCookie, /;\s*Path=\//i)
  const sessionCookie = setCookie.split(";", 1)[0]

  const page = await localFetch(harness, "/", {
    headers: { Cookie: sessionCookie },
  })
  assert.equal(page.status, 200)
  const html = await page.text()
  const csrfMatch = html.match(
    /<meta name="csrf-token" content="([A-Za-z0-9_-]+)">/
  )
  assert.ok(csrfMatch)
  assert.doesNotMatch(html, /__FACE_LABELER_CSRF__/)

  harness.sessionCookie = sessionCookie
  harness.csrfToken = csrfMatch[1]
}

function authenticatedHeaders(harness, additional = {}) {
  assert.ok(harness.sessionCookie)
  return {
    Cookie: harness.sessionCookie,
    ...additional,
  }
}

async function postJson(
  harness,
  pathname,
  body,
  { origin = harness.origin, csrf = harness.csrfToken } = {}
) {
  const headers = authenticatedHeaders(harness)
  if (origin !== null) headers.Origin = origin
  if (csrf !== null) headers["X-Face-Labeler-CSRF"] = csrf
  if (body !== undefined) headers["Content-Type"] = "application/json"
  return localFetch(harness, pathname, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function expectJson(response, expectedStatus) {
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json\b/
  )
  const payload = await response.json()
  assert.equal(
    response.status,
    expectedStatus,
    `Unexpected JSON response: ${JSON.stringify(payload)}`
  )
  return payload
}

function databaseRows(harness, sql, parameters = []) {
  const database = new DatabaseSync(harness.databasePath, {
    readOnly: true,
  })
  try {
    return database.prepare(sql).all(...parameters)
  } finally {
    database.close()
  }
}

function databaseRow(harness, sql, parameters = []) {
  const database = new DatabaseSync(harness.databasePath, {
    readOnly: true,
  })
  try {
    return database.prepare(sql).get(...parameters)
  } finally {
    database.close()
  }
}

function rawLocalRequest(harness, options) {
  assert.equal(harness.origin, `http://127.0.0.1:${harness.port}`)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: harness.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks = []
        response.on("data", (chunk) => chunks.push(chunk))
        response.once("error", reject)
        response.once("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          })
        })
      }
    )
    request.once("error", reject)
    if (options.body) request.write(options.body)
    request.end()
  })
}

test(
  "bootstraps a localhost-only authenticated session",
  { concurrency: false, timeout: 20_000 },
  async () =>
    withHarness("session-bootstrap", async (harness) => {
      structuredLog("session-bootstrap", "act", "unauthenticated_api")
      const unauthenticated = await localFetch(harness, "/api/bootstrap")
      const unauthenticatedBody = await expectJson(unauthenticated, 401)
      assert.equal(unauthenticatedBody.error, "Local session required.")

      await establishSession(harness)
      const bootstrapResponse = await localFetch(
        harness,
        "/api/bootstrap?status=unreviewed",
        { headers: authenticatedHeaders(harness) }
      )
      const bootstrap = await expectJson(bootstrapResponse, 200)
      structuredLog("session-bootstrap", "assert", "db_snapshot", {
        table: "bootstrap_summary",
        photos: bootstrap.summary.photos,
        faces: bootstrap.summary.totalFaces,
        clusters: bootstrap.clusters.length,
      })

      assert.deepEqual(
        {
          photos: bootstrap.summary.photos,
          scannedPhotos: bootstrap.summary.scannedPhotos,
          totalFaces: bootstrap.summary.totalFaces,
          clusterableFaces: bootstrap.summary.clusterableFaces,
          manualOnlyFaces: bootstrap.summary.manualOnlyFaces,
          unreviewedClusters: bootstrap.summary.unreviewedClusters,
        },
        {
          photos: 8,
          scannedPhotos: 8,
          totalFaces: 9,
          clusterableFaces: 9,
          manualOnlyFaces: 0,
          unreviewedClusters: 7,
        }
      )
      assert.equal(bootstrap.clusters.length, 7)
      assert.equal(
        bootstrapResponse.headers.get("cache-control"),
        "private, no-store, max-age=0"
      )
      assert.equal(
        bootstrapResponse.headers.get("x-frame-options"),
        "DENY"
      )
      assert.match(
        bootstrapResponse.headers.get("content-security-policy") ?? "",
        /frame-ancestors 'none'/
      )
    })
)

test(
  "rejects forged Host, Origin, and CSRF headers",
  { concurrency: false, timeout: 20_000 },
  async () =>
    withHarness("request-protections", async (harness) => {
      await establishSession(harness)
      const clusterId = harness.fixtures.clusters.label

      const forgedHost = await rawLocalRequest(harness, {
        path: "/api/bootstrap",
        headers: {
          Host: `localhost:${harness.port}`,
          Cookie: harness.sessionCookie,
        },
      })
      assert.equal(forgedHost.status, 421)
      assert.equal(
        JSON.parse(forgedHost.body.toString("utf8")).error,
        "Invalid local host."
      )

      const missingOrigin = await postJson(
        harness,
        `/api/clusters/${clusterId}/unknown`,
        { clientMutationId: mutationId("missing_origin") },
        { origin: null }
      )
      assert.equal(missingOrigin.status, 403)

      const forgedOrigin = await postJson(
        harness,
        `/api/clusters/${clusterId}/unknown`,
        { clientMutationId: mutationId("forged_origin") },
        { origin: "https://attacker.example" }
      )
      assert.equal(forgedOrigin.status, 403)

      const missingCsrf = await postJson(
        harness,
        `/api/clusters/${clusterId}/unknown`,
        { clientMutationId: mutationId("missing_csrf") },
        { csrf: null }
      )
      assert.equal(missingCsrf.status, 403)

      const forgedCsrf = await postJson(
        harness,
        `/api/clusters/${clusterId}/unknown`,
        { clientMutationId: mutationId("forged_csrf") },
        { csrf: "forged-token-that-does-not-match" }
      )
      assert.equal(forgedCsrf.status, 403)

      const chunkedWrongType = await rawLocalRequest(harness, {
        path: `/api/clusters/${clusterId}/unknown`,
        method: "POST",
        headers: {
          Host: `127.0.0.1:${harness.port}`,
          Cookie: harness.sessionCookie,
          Origin: harness.origin,
          "X-Face-Labeler-CSRF": harness.csrfToken,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: JSON.stringify({
          clientMutationId: mutationId("chunked_wrong_type"),
        }),
      })
      assert.equal(chunkedWrongType.status, 415)
      assert.equal(
        JSON.parse(chunkedWrongType.body.toString("utf8")).error,
        "Expected application/json."
      )

      const cluster = await expectJson(
        await localFetch(harness, `/api/clusters/${clusterId}`, {
          headers: authenticatedHeaders(harness),
        }),
        200
      )
      assert.equal(cluster.status, "unreviewed")
      assert.equal(
        databaseRow(
          harness,
          "SELECT count(*) AS count FROM actions"
        ).count,
        0
      )
      structuredLog("request-protections", "assert", "db_snapshot", {
        table: "actions",
        rowCount: 0,
      })
    })
)

test(
  "serves authenticated crop and custom-root photo bytes",
  { concurrency: false, timeout: 20_000 },
  async () =>
    withHarness("crop-serving", async (harness) => {
      await establishSession(harness)
      const face = harness.fixtures.faces.label
      const response = await localFetch(
        harness,
        `/media/crop/${encodeURIComponent(face.id)}`,
        { headers: authenticatedHeaders(harness) }
      )
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("content-type"), "image/webp")
      assert.equal(
        Number(response.headers.get("content-length")),
        face.crop.byteLength
      )
      assert.equal(
        response.headers.get("cross-origin-resource-policy"),
        "same-origin"
      )
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), face.crop)

      const photo = harness.fixtures.photos.label
      const photoResponse = await localFetch(
        harness,
        `/media/photo/${encodeURIComponent(photo.id)}`,
        { headers: authenticatedHeaders(harness) }
      )
      assert.equal(photoResponse.status, 200)
      assert.equal(photoResponse.headers.get("content-type"), "image/webp")
      assert.equal(
        Number(photoResponse.headers.get("content-length")),
        photo.display.byteLength
      )
      assert.equal(
        photoResponse.headers.get("cross-origin-resource-policy"),
        "same-origin"
      )
      assert.deepEqual(
        Buffer.from(await photoResponse.arrayBuffer()),
        photo.display
      )

      const missing = await localFetch(
        harness,
        `/media/crop/${fixtureId("f", "missing", "face")}`,
        { headers: authenticatedHeaders(harness) }
      )
      assert.equal(missing.status, 404)
      structuredLog("crop-serving", "assert", "media_verified", {
        cropBytes: face.crop.byteLength,
        displayBytes: photo.display.byteLength,
        contentType: "image/webp",
        customObjectsDirectory: true,
      })
    })
)

test(
  "labels a cluster and fully undoes the committed mutation",
  { concurrency: false, timeout: 20_000 },
  async () =>
    withHarness("label-undo", async (harness) => {
      await establishSession(harness)
      const clusterId = harness.fixtures.clusters.label
      const labelResponse = await postJson(
        harness,
        `/api/clusters/${clusterId}/label`,
        {
          name: "  Alex   Example  ",
          clientMutationId: mutationId("label"),
        }
      )
      const labeled = await expectJson(labelResponse, 200)
      assert.equal(labeled.id, clusterId)
      assert.equal(labeled.status, "labeled")
      assert.equal(labeled.displayName, "Alex Example")
      assert.ok(labeled.personId)

      const duplicateLabel = await expectJson(
        await postJson(
          harness,
          `/api/clusters/${clusterId}/label`,
          {
            name: "Alex Example",
            clientMutationId: mutationId("duplicate_label"),
          }
        ),
        200
      )
      assert.equal(duplicateLabel.noOp, true)
      assert.equal(duplicateLabel.id, clusterId)
      assert.equal(duplicateLabel.status, "labeled")
      assert.equal(duplicateLabel.personId, labeled.personId)
      assert.equal(
        databaseRow(
          harness,
          "SELECT count(*) AS count FROM actions"
        ).count,
        1
      )

      const labeledRows = databaseRows(
        harness,
        "SELECT status, person_id FROM faces WHERE cluster_id=?",
        [clusterId]
      )
      assert.equal(labeledRows.length, 1)
      assert.equal(labeledRows[0].status, "labeled")
      assert.equal(labeledRows[0].person_id, labeled.personId)
      assert.equal(
        databaseRow(
          harness,
          "SELECT count(*) AS count FROM people"
        ).count,
        1
      )
      structuredLog("label-undo", "assert", "db_snapshot", {
        table: "faces",
        status: labeledRows[0].status,
        rowCount: labeledRows.length,
      })

      const undo = await expectJson(
        await postJson(harness, "/api/undo", undefined),
        200
      )
      assert.deepEqual(undo, {
        undone: true,
        actionType: "label_cluster",
      })
      const restored = await expectJson(
        await localFetch(harness, `/api/clusters/${clusterId}`, {
          headers: authenticatedHeaders(harness),
        }),
        200
      )
      assert.equal(restored.status, "unreviewed")
      assert.equal(restored.personId, null)
      assert.equal(
        databaseRow(
          harness,
          "SELECT count(*) AS count FROM people"
        ).count,
        0
      )
      assert.ok(
        databaseRow(
          harness,
          "SELECT undone_at FROM actions ORDER BY id DESC LIMIT 1"
        ).undone_at
      )
      assert.deepEqual(
        await expectJson(
          await postJson(harness, "/api/undo", undefined),
          200
        ),
        { undone: false }
      )
      structuredLog("label-undo", "assert", "no_op_verified", {
        actions: 1,
        effectiveUndos: 1,
      })
    })
)

test(
  "keeps disposed faces personless while labeling usable faces",
  { concurrency: false, timeout: 20_000 },
  async () =>
    withHarness("disposed-face-labeling", async (harness) => {
      await establishSession(harness)

      const ignoredClusterId = harness.fixtures.clusters.state
      const ignoredFaceId = harness.fixtures.faces.state_b.id
      const usableFaceId = harness.fixtures.faces.state_a.id
      const afterIgnore = await expectJson(
        await postJson(
          harness,
          `/api/faces/${ignoredFaceId}/ignore`,
          { clientMutationId: mutationId("ignore_high_quality") }
        ),
        200
      )
      assert.equal(afterIgnore.representativeFaceId, usableFaceId)
      const labeledWithIgnored = await expectJson(
        await postJson(
          harness,
          `/api/clusters/${ignoredClusterId}/label`,
          {
            name: "Ignored Outlier Person",
            clientMutationId: mutationId("label_after_ignore"),
          }
        ),
        200
      )
      assert.equal(labeledWithIgnored.status, "labeled")
      assert.equal(labeledWithIgnored.representativeFaceId, usableFaceId)
      assert.deepEqual(
        databaseRows(
          harness,
          "SELECT id, status, person_id FROM faces WHERE cluster_id=? ORDER BY id",
          [ignoredClusterId]
        )
          .map((row) => ({
            id: row.id,
            status: row.status,
            personId: row.person_id,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        [
          {
            id: ignoredFaceId,
            status: "ignored",
            personId: null,
          },
          {
            id: usableFaceId,
            status: "labeled",
            personId: labeledWithIgnored.personId,
          },
        ].sort((left, right) => left.id.localeCompare(right.id))
      )
      const undoIgnoredLabel = await expectJson(
        await postJson(harness, "/api/undo", undefined),
        200
      )
      assert.equal(undoIgnoredLabel.actionType, "label_cluster")
      const restoredIgnoredCluster = await expectJson(
        await localFetch(
          harness,
          `/api/clusters/${ignoredClusterId}`,
          { headers: authenticatedHeaders(harness) }
        ),
        200
      )
      assert.equal(restoredIgnoredCluster.status, "unreviewed")
      assert.equal(
        restoredIgnoredCluster.representativeFaceId,
        usableFaceId
      )
      assert.deepEqual(
        databaseRows(
          harness,
          "SELECT id, status, person_id FROM faces WHERE cluster_id=? ORDER BY id",
          [ignoredClusterId]
        ).map((row) => ({
          id: row.id,
          status: row.status,
          personId: row.person_id,
        })),
        [ignoredFaceId, usableFaceId]
          .sort()
          .map((faceId) => ({
            id: faceId,
            status: faceId === ignoredFaceId ? "ignored" : "unreviewed",
            personId: null,
          }))
      )

      const unknownClusterId = harness.fixtures.clusters.split
      const unknownFaceId = harness.fixtures.faces.split_a.id
      const secondUsableFaceId = harness.fixtures.faces.split_b.id
      const afterUnknown = await expectJson(
        await postJson(
          harness,
          `/api/faces/${unknownFaceId}/unknown`,
          { clientMutationId: mutationId("unknown_outlier") }
        ),
        200
      )
      assert.equal(afterUnknown.representativeFaceId, secondUsableFaceId)
      const labeledWithUnknown = await expectJson(
        await postJson(
          harness,
          `/api/clusters/${unknownClusterId}/label`,
          {
            name: "Unknown Outlier Person",
            clientMutationId: mutationId("label_after_unknown"),
          }
        ),
        200
      )
      assert.equal(labeledWithUnknown.status, "labeled")
      assert.equal(
        labeledWithUnknown.representativeFaceId,
        secondUsableFaceId
      )
      const unknownRow = databaseRow(
        harness,
        "SELECT status, person_id FROM faces WHERE id=?",
        [unknownFaceId]
      )
      assert.equal(unknownRow.status, "unknown")
      assert.equal(unknownRow.person_id, null)
      const usableRow = databaseRow(
        harness,
        "SELECT status, person_id FROM faces WHERE id=?",
        [secondUsableFaceId]
      )
      assert.equal(usableRow.status, "labeled")
      assert.equal(usableRow.person_id, labeledWithUnknown.personId)
      const undoUnknownLabel = await expectJson(
        await postJson(harness, "/api/undo", undefined),
        200
      )
      assert.equal(undoUnknownLabel.actionType, "label_cluster")
      const restoredUnknownCluster = await expectJson(
        await localFetch(
          harness,
          `/api/clusters/${unknownClusterId}`,
          { headers: authenticatedHeaders(harness) }
        ),
        200
      )
      assert.equal(restoredUnknownCluster.status, "unreviewed")
      assert.equal(
        restoredUnknownCluster.representativeFaceId,
        secondUsableFaceId
      )
      const restoredUnknown = databaseRow(
        harness,
        "SELECT status, person_id FROM faces WHERE id=?",
        [unknownFaceId]
      )
      const restoredUsable = databaseRow(
        harness,
        "SELECT status, person_id FROM faces WHERE id=?",
        [secondUsableFaceId]
      )
      assert.deepEqual(
        {
          unknownStatus: restoredUnknown.status,
          unknownPersonId: restoredUnknown.person_id,
          usableStatus: restoredUsable.status,
          usablePersonId: restoredUsable.person_id,
          people: databaseRow(
            harness,
            "SELECT count(*) AS count FROM people"
          ).count,
        },
        {
          unknownStatus: "unknown",
          unknownPersonId: null,
          usableStatus: "unreviewed",
          usablePersonId: null,
          people: 0,
        }
      )

      structuredLog(
        "disposed-face-labeling",
        "assert",
        "db_snapshot",
        {
          table: "faces",
          ignoredPreserved: 1,
          unknownPreserved: 1,
          labeledUsable: 2,
        }
      )
    })
)

test(
  "splits a cluster, records cannot-links, and undoes both",
  { concurrency: false, timeout: 20_000 },
  async () =>
    withHarness("split-undo", async (harness) => {
      await establishSession(harness)
      const clusterId = harness.fixtures.clusters.split
      const selectedFace = harness.fixtures.faces.split_a.id
      const suggestionSql = `SELECT
        cluster_id_a, cluster_id_b,
        similarity_max, similarity_median, similarity_min,
        status, created_at
       FROM cluster_suggestions
       WHERE cluster_id_a=? OR cluster_id_b=?`
      const suggestionBeforeSplit = Object.fromEntries(
        Object.entries(
          databaseRow(harness, suggestionSql, [clusterId, clusterId])
        )
      )
      assert.deepEqual(
        {
          max: suggestionBeforeSplit.similarity_max,
          median: suggestionBeforeSplit.similarity_median,
          min: suggestionBeforeSplit.similarity_min,
          status: suggestionBeforeSplit.status,
        },
        {
          max: 0.83,
          median: 0.79,
          min: 0.73,
          status: "rejected",
        }
      )
      const split = await expectJson(
        await postJson(
          harness,
          `/api/clusters/${clusterId}/split`,
          {
            faceIds: [selectedFace],
            clientMutationId: mutationId("split"),
          }
        ),
        200
      )
      assert.equal(split.source.id, clusterId)
      assert.equal(split.source.faceCount, 1)
      assert.equal(split.created.faceCount, 1)
      assert.equal(split.created.origin, undefined)
      assert.notEqual(split.created.id, clusterId)
      assert.equal(
        databaseRow(harness, suggestionSql, [clusterId, clusterId]),
        undefined
      )
      assert.equal(
        databaseRow(
          harness,
          "SELECT count(*) AS count FROM cannot_links WHERE reason='manual_split'"
        ).count,
        1
      )
      structuredLog("split-undo", "assert", "db_snapshot", {
        table: "cannot_links",
        rowCount: 1,
      })

      const undo = await expectJson(
        await postJson(harness, "/api/actions/undo", {}),
        200
      )
      assert.equal(undo.undone, true)
      assert.equal(undo.actionType, "split_cluster")
      const restored = await expectJson(
        await localFetch(harness, `/api/clusters/${clusterId}`, {
          headers: authenticatedHeaders(harness),
        }),
        200
      )
      assert.equal(restored.faceCount, 2)
      assert.equal(
        (
          await localFetch(
            harness,
            `/api/clusters/${split.created.id}`,
            { headers: authenticatedHeaders(harness) }
          )
        ).status,
        404
      )
      assert.equal(
        databaseRow(
          harness,
          "SELECT count(*) AS count FROM cannot_links WHERE reason='manual_split'"
        ).count,
        0
      )
      const restoredSuggestion = databaseRow(
        harness,
        suggestionSql,
        [clusterId, clusterId]
      )
      assert.ok(restoredSuggestion)
      assert.deepEqual(
        Object.fromEntries(Object.entries(restoredSuggestion)),
        suggestionBeforeSplit
      )
      structuredLog("split-undo", "assert", "suggestion_restored", {
        status: restoredSuggestion.status,
        max: restoredSuggestion.similarity_max,
        median: restoredSuggestion.similarity_median,
        min: restoredSuggestion.similarity_min,
      })
    })
)

test(
  "splits a labeled cluster without transferring its identity",
  { concurrency: false, timeout: 20_000 },
  async () =>
    withHarness("labeled-split-undo", async (harness) => {
      await establishSession(harness)
      const clusterId = harness.fixtures.clusters.split
      const selectedFaceId = harness.fixtures.faces.split_a.id
      const remainingFaceId = harness.fixtures.faces.split_b.id

      const labeled = await expectJson(
        await postJson(
          harness,
          `/api/clusters/${clusterId}/label`,
          {
            name: "Split Identity Person",
            clientMutationId: mutationId("label_before_split"),
          }
        ),
        200
      )
      assert.equal(labeled.status, "labeled")
      assert.ok(labeled.personId)

      const clusterBeforeSplitRow = databaseRow(
        harness,
        `SELECT
          id, origin, status, person_id, representative_face_id,
          revision, reviewed_at, created_at, updated_at
         FROM clusters WHERE id=?`,
        [clusterId]
      )
      const clusterBeforeSplit = Object.fromEntries(
        Object.entries(clusterBeforeSplitRow)
      )
      const facesBeforeSplit = databaseRows(
        harness,
        `SELECT
          id, cluster_id, person_id, status, revision, updated_at
         FROM faces WHERE cluster_id=? ORDER BY id`,
        [clusterId]
      ).map((row) => Object.fromEntries(Object.entries(row)))

      const split = await expectJson(
        await postJson(
          harness,
          `/api/clusters/${clusterId}/split`,
          {
            faceIds: [selectedFaceId],
            clientMutationId: mutationId("split_labeled_cluster"),
          }
        ),
        200
      )
      assert.equal(split.source.id, clusterId)
      assert.equal(split.source.status, "labeled")
      assert.equal(split.source.personId, labeled.personId)
      assert.equal(split.source.faceCount, 1)
      assert.equal(split.created.status, "unreviewed")
      assert.equal(split.created.personId, null)
      assert.equal(split.created.faceCount, 1)

      const selectedAfterSplit = databaseRow(
        harness,
        "SELECT cluster_id, person_id, status FROM faces WHERE id=?",
        [selectedFaceId]
      )
      assert.deepEqual(
        {
          clusterId: selectedAfterSplit.cluster_id,
          personId: selectedAfterSplit.person_id,
          status: selectedAfterSplit.status,
        },
        {
          clusterId: split.created.id,
          personId: null,
          status: "unreviewed",
        }
      )
      const remainingAfterSplit = databaseRow(
        harness,
        "SELECT cluster_id, person_id, status FROM faces WHERE id=?",
        [remainingFaceId]
      )
      assert.deepEqual(
        {
          clusterId: remainingAfterSplit.cluster_id,
          personId: remainingAfterSplit.person_id,
          status: remainingAfterSplit.status,
        },
        {
          clusterId,
          personId: labeled.personId,
          status: "labeled",
        }
      )

      const undo = await expectJson(
        await postJson(harness, "/api/undo", undefined),
        200
      )
      assert.deepEqual(undo, {
        undone: true,
        actionType: "split_cluster",
      })
      const restoredCluster = databaseRow(
        harness,
        `SELECT
          id, origin, status, person_id, representative_face_id,
          revision, reviewed_at, created_at, updated_at
         FROM clusters WHERE id=?`,
        [clusterId]
      )
      const restoredFaces = databaseRows(
        harness,
        `SELECT
          id, cluster_id, person_id, status, revision, updated_at
         FROM faces WHERE cluster_id=? ORDER BY id`,
        [clusterId]
      ).map((row) => Object.fromEntries(Object.entries(row)))
      assert.deepEqual(
        Object.fromEntries(Object.entries(restoredCluster)),
        clusterBeforeSplit
      )
      assert.deepEqual(restoredFaces, facesBeforeSplit)
      assert.equal(
        (
          await localFetch(
            harness,
            `/api/clusters/${split.created.id}`,
            { headers: authenticatedHeaders(harness) }
          )
        ).status,
        404
      )
      assert.equal(
        databaseRow(
          harness,
          "SELECT count(*) AS count FROM cannot_links WHERE reason='manual_split'"
        ).count,
        0
      )
      assert.equal(
        databaseRow(
          harness,
          "SELECT count(*) AS count FROM people WHERE id=?",
          [labeled.personId]
        ).count,
        1
      )

      structuredLog(
        "labeled-split-undo",
        "assert",
        "exact_state_restored",
        {
          clusterStatus: "labeled",
          faces: restoredFaces.length,
          personPreserved: true,
        }
      )
    })
)

test(
  "merges compatible clusters and restores both clusters on undo",
  { concurrency: false, timeout: 20_000 },
  async () =>
    withHarness("merge-undo", async (harness) => {
      await establishSession(harness)
      const clusterIds = [
        harness.fixtures.clusters.merge_a,
        harness.fixtures.clusters.merge_b,
      ]
      const [target, source] = [...clusterIds].sort()
      const mergeSuggestionCountSql =
        `SELECT count(*) AS count FROM cluster_suggestions
         WHERE cluster_id_a IN (?,?) OR cluster_id_b IN (?,?)`
      const mergeSuggestionParameters = [
        target,
        source,
        target,
        source,
      ]
      assert.equal(
        databaseRow(
          harness,
          mergeSuggestionCountSql,
          mergeSuggestionParameters
        ).count,
        1
      )
      const merged = await expectJson(
        await postJson(harness, "/api/clusters/merge", {
          clusterIds: [...clusterIds].reverse(),
          clientMutationId: mutationId("merge"),
        }),
        200
      )
      assert.equal(merged.id, target)
      assert.equal(merged.faceCount, 2)
      assert.equal(
        (
          await localFetch(harness, `/api/clusters/${source}`, {
            headers: authenticatedHeaders(harness),
          })
        ).status,
        404
      )
      assert.deepEqual(
        databaseRows(
          harness,
          "SELECT DISTINCT cluster_id FROM faces WHERE id IN (?,?) ORDER BY cluster_id",
          [
            harness.fixtures.faces.merge_a.id,
            harness.fixtures.faces.merge_b.id,
          ]
        ).map((row) => row.cluster_id),
        [target]
      )
      assert.equal(
        databaseRow(
          harness,
          mergeSuggestionCountSql,
          mergeSuggestionParameters
        ).count,
        0
      )

      const undo = await expectJson(
        await postJson(harness, "/api/undo", undefined),
        200
      )
      assert.equal(undo.actionType, "merge_clusters")
      for (const clusterId of clusterIds) {
        const restored = await expectJson(
          await localFetch(harness, `/api/clusters/${clusterId}`, {
            headers: authenticatedHeaders(harness),
          }),
          200
        )
        assert.equal(restored.faceCount, 1)
      }
      const restoredSuggestion = databaseRow(
        harness,
        `SELECT
          cluster_id_a, cluster_id_b, similarity_max,
          similarity_median, similarity_min, status
         FROM cluster_suggestions
         WHERE cluster_id_a IN (?,?) OR cluster_id_b IN (?,?)`,
        mergeSuggestionParameters
      )
      assert.ok(restoredSuggestion)
      assert.deepEqual(
        {
          clusterIdA: restoredSuggestion.cluster_id_a,
          clusterIdB: restoredSuggestion.cluster_id_b,
          max: restoredSuggestion.similarity_max,
          median: restoredSuggestion.similarity_median,
          min: restoredSuggestion.similarity_min,
          status: restoredSuggestion.status,
        },
        {
          clusterIdA: target,
          clusterIdB: source,
          max: 0.94,
          median: 0.91,
          min: 0.87,
          status: "pending",
        }
      )
      structuredLog("merge-undo", "assert", "db_snapshot", {
        table: "clusters_and_suggestions",
        restored: 2,
        suggestions: 1,
      })
    })
)

test(
  "rejects a merge across a persisted cannot-link",
  { concurrency: false, timeout: 20_000 },
  async () =>
    withHarness("cannot-link-conflict", async (harness) => {
      await establishSession(harness)
      const clusterIds = [
        harness.fixtures.clusters.blocked_a,
        harness.fixtures.clusters.blocked_b,
      ]
      const conflict = await expectJson(
        await postJson(harness, "/api/clusters/merge", {
          clusterIds,
          clientMutationId: mutationId("blocked_merge"),
        }),
        409
      )
      assert.equal(
        conflict.error,
        "These clusters contain faces that must remain separate"
      )
      for (const clusterId of clusterIds) {
        const cluster = await expectJson(
          await localFetch(harness, `/api/clusters/${clusterId}`, {
            headers: authenticatedHeaders(harness),
          }),
          200
        )
        assert.equal(cluster.faceCount, 1)
      }
      assert.equal(
        databaseRow(
          harness,
          "SELECT count(*) AS count FROM actions"
        ).count,
        0
      )
      assert.equal(
        databaseRow(
          harness,
          "SELECT count(*) AS count FROM cannot_links"
        ).count,
        1
      )
      structuredLog(
        "cannot-link-conflict",
        "assert",
        "transaction_rollback_verified",
        { actions: 0, cannotLinks: 1 }
      )
    })
)

test(
  "moves clusters and faces through unknown, ignored, and recovered states",
  { concurrency: false, timeout: 20_000 },
  async () =>
    withHarness("disposition-recovery", async (harness) => {
      await establishSession(harness)
      const clusterId = harness.fixtures.clusters.state
      const faceId = harness.fixtures.faces.state_a.id

      for (const [action, expectedStatus] of [
        ["unknown", "unknown"],
        ["unignore", "unreviewed"],
        ["ignore", "ignored"],
        ["unignore", "unreviewed"],
      ]) {
        const cluster = await expectJson(
          await postJson(
            harness,
            `/api/clusters/${clusterId}/${action}`,
            { clientMutationId: mutationId(`cluster_${action}`) }
          ),
          200
        )
        assert.equal(cluster.status, expectedStatus)
        const faceStates = databaseRows(
          harness,
          "SELECT DISTINCT status FROM faces WHERE cluster_id=? ORDER BY status",
          [clusterId]
        )
        assert.deepEqual(
          faceStates.map((row) => row.status),
          [expectedStatus]
        )
      }

      for (const [action, expectedStatus] of [
        ["unknown", "unknown"],
        ["ignore", "ignored"],
        ["unignore", "unreviewed"],
      ]) {
        await expectJson(
          await postJson(
            harness,
            `/api/faces/${faceId}/${action}`,
            { clientMutationId: mutationId(`face_${action}`) }
          ),
          200
        )
        assert.equal(
          databaseRow(
            harness,
            "SELECT status FROM faces WHERE id=?",
            [faceId]
          ).status,
          expectedStatus
        )
      }

      const finalCluster = await expectJson(
        await localFetch(harness, `/api/clusters/${clusterId}`, {
          headers: authenticatedHeaders(harness),
        }),
        200
      )
      assert.equal(finalCluster.status, "unreviewed")
      structuredLog("disposition-recovery", "assert", "db_snapshot", {
        table: "faces",
        recoveredFace: faceId,
        status: "unreviewed",
      })
    })
)
