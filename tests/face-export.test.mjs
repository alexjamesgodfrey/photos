import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIRECTORY, "..")
const EXPORT_SCRIPT = path.join(REPO_ROOT, "tools", "face-labeler", "export.mjs")
const UPLOAD_SCRIPT = path.join(REPO_ROOT, "scripts", "upload-r2.mjs")
const SCHEMA_PATH = path.join(REPO_ROOT, "tools", "face-labeler", "schema.sql")
const PRIVATE_TEST_ROOT = path.join(REPO_ROOT, ".media-staging")
const PERSON_ID = `person_${"1".repeat(32)}`
const LOW_FACE_ID = `f_${"2".repeat(32)}`
const HIGH_FACE_ID = `f_${"3".repeat(32)}`
const ACCOUNT_ID = "0".repeat(32)
const NOW = "2026-07-27T22:00:00.000Z"

test(
  "exports one deterministic, verified avatar without biometric source fields",
  { concurrency: false, timeout: 20_000 },
  async () => {
    const harness = await createExportHarness()
    try {
      const exported = await runNode([
        EXPORT_SCRIPT,
        "--workspace",
        harness.workspace,
        "--apply",
      ])
      assert.equal(exported.code, 0, exported.stderr)

      const summary = JSON.parse(exported.stdout)
      assert.deepEqual(
        {
          people: summary.people,
          photoPeople: summary.photoPeople,
          avatars: summary.avatars,
          avatarBytes: summary.avatarBytes,
        },
        {
          people: 1,
          photoPeople: 2,
          avatars: 1,
          avatarBytes: harness.high.bytes.length,
        }
      )

      const outputDirectory = path.join(harness.workspace, "export")
      const artifact = JSON.parse(
        await readFile(path.join(outputDirectory, "people.json"), "utf8")
      )
      assert.equal(artifact.schemaVersion, 2)
      assert.equal(artifact.people.length, 1)
      assert.deepEqual(
        Object.keys(artifact.people[0]).sort(),
        [
          "avatarHeight",
          "avatarKey",
          "avatarSha256",
          "avatarWidth",
          "displayName",
          "id",
          "photoCount",
          "slug",
        ].sort()
      )
      assert.deepEqual(artifact.people[0], {
        id: PERSON_ID,
        slug: `person-${"1".repeat(12)}`,
        displayName: "Alex",
        photoCount: 2,
        avatarKey:
          `wedding/people/${PERSON_ID}/avatar-`
          + `${harness.high.sha256.slice(0, 20)}.webp`,
        avatarSha256: harness.high.sha256,
        avatarWidth: 320,
        avatarHeight: 320,
      })
      assert.equal(JSON.stringify(artifact).includes(HIGH_FACE_ID), false)
      assert.equal(JSON.stringify(artifact).includes("crop_relpath"), false)
      assert.equal(JSON.stringify(artifact).includes("local_path"), false)
      assert.equal(JSON.stringify(artifact).includes("embedding"), false)
      assert.equal(JSON.stringify(artifact).includes("bbox"), false)

      const uploadPlan = await readNdjson(
        path.join(outputDirectory, "avatar-upload-plan.ndjson")
      )
      assert.deepEqual(uploadPlan, [
        {
          person_id: PERSON_ID,
          kind: "avatar",
          object_key: artifact.people[0].avatarKey,
          local_path: harness.high.path,
          content_type: "image/webp",
          cache_control: "public, max-age=31536000, immutable",
          sha256: harness.high.sha256,
          bytes: harness.high.bytes.length,
        },
      ])

      const sql = await readFile(path.join(outputDirectory, "people.sql"), "utf8")
      assert.match(sql, /\bavatar_key\b/)
      assert.match(sql, /\bavatar_sha256\b/)
      assert.match(sql, /\bavatar_width\b/)
      assert.match(sql, /\bavatar_height\b/)
      assert.match(sql, new RegExp(harness.high.sha256))
      assert.doesNotMatch(sql, new RegExp(HIGH_FACE_ID))
      assert.doesNotMatch(sql, /crop_relpath|local_path|embedding_f32|bbox_/)

      const uploadDryRun = await runNode([
        UPLOAD_SCRIPT,
        "--manifest",
        path.join(outputDirectory, "avatar-upload-plan.ndjson"),
        "--profile",
        "test-profile",
        "--account-id",
        ACCOUNT_ID,
      ])
      assert.equal(uploadDryRun.code, 0, uploadDryRun.stderr)
      assert.match(uploadDryRun.stdout, /Dry-run: 1 objects/)

      await appendFile(harness.high.path, Buffer.from([0]))
      const tampered = await runNode([
        EXPORT_SCRIPT,
        "--workspace",
        harness.workspace,
      ])
      assert.equal(tampered.code, 1)
      assert.match(tampered.stderr, /Avatar crop SHA-256 changed/)
    } finally {
      await harness.cleanup()
    }
  }
)

test(
  "rejects an avatar crop with dimensions outside the verified workspace profile",
  { concurrency: false, timeout: 20_000 },
  async () => {
    const harness = await createExportHarness({ highSide: 256 })
    try {
      const result = await runNode([
        EXPORT_SCRIPT,
        "--workspace",
        harness.workspace,
      ])
      assert.equal(result.code, 1)
      assert.match(result.stderr, /Avatar crop must be a 320x320 WebP/)
    } finally {
      await harness.cleanup()
    }
  }
)

test(
  "avatar uploader rejects identity, source-root, and source-hash mismatches",
  { concurrency: false, timeout: 20_000 },
  async () => {
    const harness = await createExportHarness()
    const outsideDirectory = await mkdtemp(
      path.join(os.tmpdir(), "face-avatar-source-")
    )
    try {
      const validEntry = {
        person_id: PERSON_ID,
        kind: "avatar",
        object_key:
          `wedding/people/${PERSON_ID}/avatar-`
          + `${harness.high.sha256.slice(0, 20)}.webp`,
        local_path: harness.high.path,
        content_type: "image/webp",
        cache_control: "public, max-age=31536000, immutable",
        sha256: harness.high.sha256,
        bytes: harness.high.bytes.length,
      }

      const wrongIdentity = {
        ...validEntry,
        person_id: `person_${"9".repeat(32)}`,
      }
      const wrongIdentityResult = await runUploaderFixture(
        harness.workspace,
        "wrong-identity.ndjson",
        wrongIdentity
      )
      assert.equal(wrongIdentityResult.code, 1)
      assert.match(wrongIdentityResult.stderr, /key identity does not match/)

      const outsideRoot = {
        ...validEntry,
        local_path: path.join("/tmp", "private-face.webp"),
      }
      const outsideRootResult = await runUploaderFixture(
        harness.workspace,
        "outside-root.ndjson",
        outsideRoot
      )
      assert.equal(outsideRootResult.code, 1)
      assert.match(outsideRootResult.stderr, /private WebP crop/)

      const outsideCrop = path.join(outsideDirectory, "avatar.webp")
      await writeFile(outsideCrop, harness.high.bytes, { mode: 0o600 })
      const symlinkedCrop = path.join(harness.workspace, "crops", "escape.webp")
      await symlink(outsideCrop, symlinkedCrop)
      const symlinkEscape = {
        ...validEntry,
        local_path: symlinkedCrop,
      }
      const symlinkEscapeResult = await runUploaderFixture(
        harness.workspace,
        "symlink-escape.ndjson",
        symlinkEscape
      )
      assert.equal(symlinkEscapeResult.code, 1)
      assert.match(symlinkEscapeResult.stderr, /outside the private media workspace/)

      const wrongSha = "f".repeat(64)
      const wrongHash = {
        ...validEntry,
        object_key:
          `wedding/people/${PERSON_ID}/avatar-${wrongSha.slice(0, 20)}.webp`,
        sha256: wrongSha,
      }
      const wrongHashResult = await runUploaderFixture(
        harness.workspace,
        "wrong-hash.ndjson",
        wrongHash
      )
      assert.equal(wrongHashResult.code, 1)
      assert.match(wrongHashResult.stderr, /avatar source SHA-256 mismatch/)
    } finally {
      await harness.cleanup()
      await rm(outsideDirectory, { recursive: true, force: true })
    }
  }
)

async function createExportHarness(options = {}) {
  await mkdir(PRIVATE_TEST_ROOT, { recursive: true })
  const workspace = await mkdtemp(
    path.join(PRIVATE_TEST_ROOT, "face-export-test-")
  )
  await chmod(workspace, 0o700)
  const crops = path.join(workspace, "crops")
  await mkdir(crops, { recursive: true, mode: 0o700 })

  const low = await writeCrop({
    workspace,
    faceId: LOW_FACE_ID,
    side: 320,
    color: "#75524a",
  })
  const high = await writeCrop({
    workspace,
    faceId: HIGH_FACE_ID,
    side: options.highSide ?? 320,
    color: "#d6b38c",
  })

  const databasePath = path.join(workspace, "faces.sqlite3")
  const database = new DatabaseSync(databasePath)
  database.exec(await readFile(SCHEMA_PATH, "utf8"))
  database
    .prepare(
      `INSERT INTO workspace (
         id, schema_version, album_id, source_manifest_sha256,
         detector_sha256, embedder_sha256, pipeline_version, config_json,
         cluster_run_key, action_high_watermark, created_at, updated_at
       ) VALUES (1, 1, 'wedding', ?, ?, ?, '1.0.0', ?, ?, 7, ?, ?)`
    )
    .run(
      digest("manifest"),
      digest("detector"),
      digest("embedder"),
      JSON.stringify({ crop: { side_px: 320 } }),
      digest("cluster-run"),
      NOW,
      NOW
    )
  database
    .prepare(
      `INSERT INTO people (id, display_name, name_key, created_at, updated_at)
       VALUES (?, 'Alex', 'alex', ?, ?)`
    )
    .run(PERSON_ID, NOW, NOW)

  const photos = [
    { id: `p_${"4".repeat(32)}`, position: 0, face: low },
    { id: `p_${"5".repeat(32)}`, position: 1, face: high },
  ]
  for (const photo of photos) {
    database
      .prepare(
        `INSERT INTO photos (
           id, album_position, source_fingerprint, display_relpath,
           display_sha256, width, height, scan_key, scan_status,
           face_count, processed_at
         ) VALUES (?, ?, ?, ?, ?, 2560, 1708, ?, 'complete', 1, ?)`
      )
      .run(
        photo.id,
        photo.position,
        digest(`source-${photo.position}`),
        `web/objects/wedding/${photo.position}/display.webp`,
        digest(`display-${photo.position}`),
        digest(`scan-${photo.position}`),
        NOW
      )
    const clusterId = `c_${String(photo.position + 6).repeat(24)}`
    database
      .prepare(
        `INSERT INTO clusters (
           id, origin, status, person_id, representative_face_id,
           revision, reviewed_at, created_at, updated_at
         ) VALUES (?, 'automatic', 'labeled', ?, ?, 1, ?, ?, ?)`
      )
      .run(clusterId, PERSON_ID, photo.face.faceId, NOW, NOW, NOW)
    database
      .prepare(
        `INSERT INTO faces (
           id, photo_id, cluster_id, person_id, ordinal,
           bbox_x, bbox_y, bbox_width, bbox_height, landmarks_json,
           detection_score, width_px, height_px, quality, quality_score,
           crop_relpath, crop_sha256, status, revision, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, 0,
           0.2, 0.2, 0.3, 0.4, '[]',
           ?, ?, ?, 'clusterable', ?,
           ?, ?, 'labeled', 1, ?, ?
         )`
      )
      .run(
        photo.face.faceId,
        photo.id,
        clusterId,
        PERSON_ID,
        photo.position === 0 ? 0.91 : 0.96,
        photo.position === 0 ? 120 : 240,
        photo.position === 0 ? 130 : 260,
        photo.position === 0 ? 0.6 : 0.95,
        photo.face.relativePath,
        photo.face.sha256,
        NOW,
        NOW
      )
  }
  database.close()

  return {
    workspace,
    low,
    high,
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  }
}

async function writeCrop({ workspace, faceId, side, color }) {
  const relativePath = path.join("crops", faceId.slice(0, 4), `${faceId}.webp`)
  const destination = path.join(workspace, relativePath)
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const bytes = await sharp({
    create: {
      width: side,
      height: side,
      channels: 3,
      background: color,
    },
  })
    .webp({ quality: 88 })
    .toBuffer()
  await writeFile(destination, bytes, { mode: 0o600 })
  return {
    faceId,
    path: destination,
    relativePath,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

async function runUploaderFixture(workspace, filename, entry) {
  const manifest = path.join(workspace, filename)
  await writeFile(manifest, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  return runNode([
    UPLOAD_SCRIPT,
    "--manifest",
    manifest,
    "--profile",
    "test-profile",
    "--account-id",
    ACCOUNT_ID,
  ])
}

async function readNdjson(filename) {
  return (await readFile(filename, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function runNode(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (code) => {
      resolve({ code, stdout, stderr })
    })
  })
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}
