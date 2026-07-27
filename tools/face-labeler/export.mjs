#!/usr/bin/env node

import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TOOL_DIRECTORY, "../..")
const DEFAULT_WORKSPACE = path.join(REPO_ROOT, ".media-staging", "faces")
const AVATAR_PREFIX = "wedding/people"
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
const PERSON_ID_PATTERN = /^person_[a-f0-9]{32}$/

main().catch((error) => {
  console.error(`Face export failed: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const requestedWorkspace = path.resolve(options.workspace ?? DEFAULT_WORKSPACE)
  assertWorkspace(requestedWorkspace)
  const workspace = await realpath(requestedWorkspace).catch(() => null)
  const privateRoot = await realpath(path.join(REPO_ROOT, ".media-staging"))
  if (!workspace || !isChildPath(privateRoot, workspace)) {
    throw new Error("Workspace is missing or resolves outside .media-staging")
  }
  const database = new DatabaseSync(path.join(workspace, "faces.sqlite3"), {
    readOnly: true,
    timeout: 5_000,
  })
  database.exec("PRAGMA foreign_keys = ON")
  let artifact
  let avatarUploads
  database.exec("BEGIN")
  try {
    const built = await buildArtifact(database, workspace)
    artifact = built.artifact
    avatarUploads = built.avatarUploads
    validateArtifact(
      database,
      artifact,
      avatarUploads,
      options.allowIncomplete
    )
    database.exec("COMMIT")
  } catch (error) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // Preserve the original validation or read error.
    }
    database.close()
    throw error
  }

  const summary = {
    people: artifact.people.length,
    photoPeople: artifact.photoPeople.length,
    unreviewedClusters: artifact.review.unreviewedClusters,
    unknownFaces: artifact.review.unknownFaces,
    ignoredFaces: artifact.review.ignoredFaces,
    avatars: avatarUploads.length,
    avatarBytes: avatarUploads.reduce((sum, upload) => sum + upload.bytes, 0),
    artifactSha256: artifact.artifactSha256,
  }
  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2))
    database.close()
    return
  }
  if (artifact.review.unreviewedClusters > 0) {
    database.close()
    throw new Error("Cannot write an authoritative export while clusters remain unreviewed")
  }

  const outputDirectory = path.resolve(
    options.output ?? path.join(workspace, "export")
  )
  const relative = path.relative(workspace, outputDirectory)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Export output must be a child of the private face workspace")
  }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  await chmod(outputDirectory, 0o700)
  await writePrivateAtomic(
    path.join(outputDirectory, "people.json"),
    `${JSON.stringify(artifact, null, 2)}\n`
  )
  await writePrivateAtomic(
    path.join(outputDirectory, "people.sql"),
    createSql(artifact)
  )
  await writePrivateAtomic(
    path.join(outputDirectory, "avatar-upload-plan.ndjson"),
    avatarUploads.length
      ? `${avatarUploads.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : ""
  )
  database.close()
  console.log(JSON.stringify({ ...summary, outputDirectory }, null, 2))
}

async function buildArtifact(database, workspacePath) {
  const workspace = database.prepare("SELECT * FROM workspace WHERE id=1").get()
  if (!workspace) throw new Error("Face workspace metadata is missing")
  const avatarSide = avatarCropSide(workspace.config_json)
  const personRows = database
    .prepare(
      `WITH person_stats AS (
         SELECT person_id, count(DISTINCT photo_id) AS photo_count
         FROM faces
         WHERE status='labeled' AND person_id IS NOT NULL
         GROUP BY person_id
       ),
       ranked_avatars AS (
         SELECT
           f.person_id, f.id AS face_id, f.crop_relpath, f.crop_sha256,
           row_number() OVER (
             PARTITION BY f.person_id
             ORDER BY
               f.quality_score DESC,
               f.detection_score DESC,
               min(f.width_px, f.height_px) DESC,
               f.id
           ) AS avatar_rank
         FROM faces f
         JOIN clusters c ON c.id=f.cluster_id
         WHERE f.status='labeled'
           AND f.person_id IS NOT NULL
           AND c.status='labeled'
           AND c.person_id=f.person_id
       )
       SELECT
         pe.id, pe.display_name, ps.photo_count,
         avatar.face_id, avatar.crop_relpath, avatar.crop_sha256
       FROM people pe
       JOIN person_stats ps ON ps.person_id=pe.id
       JOIN ranked_avatars avatar
         ON avatar.person_id=pe.id AND avatar.avatar_rank=1
       ORDER BY pe.id`
    )
    .all()
  const validatedAvatars = await Promise.all(
    personRows.map((person) =>
      validateAvatarCrop(workspacePath, person, avatarSide)
    )
  )
  const people = personRows.map((person, index) => {
    const avatar = validatedAvatars[index]
    return {
      id: person.id,
      slug: `person-${person.id.replace(/^person_/, "").slice(0, 12)}`,
      displayName: person.display_name,
      photoCount: Number(person.photo_count),
      avatarKey: avatar.objectKey,
      avatarSha256: avatar.sha256,
      avatarWidth: avatar.width,
      avatarHeight: avatar.height,
    }
  })
  const avatarUploads = personRows.map((person, index) => {
    const avatar = validatedAvatars[index]
    return {
      person_id: person.id,
      kind: "avatar",
      object_key: avatar.objectKey,
      local_path: avatar.localPath,
      content_type: "image/webp",
      cache_control: IMMUTABLE_CACHE_CONTROL,
      sha256: avatar.sha256,
      bytes: avatar.bytes,
    }
  })
  const photoPeople = database
    .prepare(
      `SELECT f.photo_id, f.person_id, min(ph.album_position) AS album_position
       FROM faces f
       JOIN photos ph ON ph.id=f.photo_id
       WHERE f.status='labeled' AND f.person_id IS NOT NULL
       GROUP BY f.photo_id, f.person_id
       ORDER BY ph.album_position, f.person_id`
    )
    .all()
    .map((row) => ({
      photoId: row.photo_id,
      personId: row.person_id,
      albumPosition: Number(row.album_position),
    }))
  const review = database
    .prepare(
      `SELECT
        (SELECT count(*) FROM clusters WHERE status='unreviewed') AS unreviewed_clusters,
        (SELECT count(*) FROM faces WHERE status='unknown') AS unknown_faces,
        (SELECT count(*) FROM faces WHERE status='ignored') AS ignored_faces,
        (SELECT count(*) FROM faces WHERE status='labeled') AS labeled_faces,
        (SELECT count(*) FROM faces) AS total_faces`
    )
    .get()
  const base = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    albumId: workspace.album_id,
    sourceManifestSha256: workspace.source_manifest_sha256,
    detectorSha256: workspace.detector_sha256,
    embedderSha256: workspace.embedder_sha256,
    pipelineVersion: workspace.pipeline_version,
    clusterRunKey: workspace.cluster_run_key,
    actionHighWatermark: Number(workspace.action_high_watermark),
    review: {
      unreviewedClusters: Number(review.unreviewed_clusters),
      unknownFaces: Number(review.unknown_faces),
      ignoredFaces: Number(review.ignored_faces),
      labeledFaces: Number(review.labeled_faces),
      totalFaces: Number(review.total_faces),
    },
    people,
    photoPeople,
  }
  return {
    artifact: {
      ...base,
      artifactSha256: createHash("sha256")
        .update(canonicalJson(base))
        .digest("hex"),
    },
    avatarUploads,
  }
}

function validateArtifact(database, artifact, avatarUploads, allowIncomplete) {
  const integrity = database.prepare("PRAGMA integrity_check").get()
  if (integrity.integrity_check !== "ok") throw new Error("SQLite integrity check failed")
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all()
  if (foreignKeys.length) throw new Error("SQLite foreign-key check failed")
  if (!allowIncomplete && artifact.review.unreviewedClusters > 0) {
    throw new Error(
      `${artifact.review.unreviewedClusters} clusters still require review; `
        + "use --allow-incomplete for a preview only"
    )
  }
  const personIds = new Set(artifact.people.map((person) => person.id))
  if (
    personIds.size !== artifact.people.length
    || artifact.photoPeople.some((entry) => !personIds.has(entry.personId))
  ) {
    throw new Error("Export contains duplicate or orphan person IDs")
  }
  const associationKeys = artifact.photoPeople.map(
    (entry) => `${entry.photoId}:${entry.personId}`
  )
  if (new Set(associationKeys).size !== associationKeys.length) {
    throw new Error("Export contains duplicate photo/person associations")
  }
  if (avatarUploads.length !== artifact.people.length) {
    throw new Error("Export does not contain exactly one avatar per person")
  }
  const avatarKeys = new Set()
  const uploadsByPerson = new Map(
    avatarUploads.map((upload) => [upload.person_id, upload])
  )
  for (const person of artifact.people) {
    const upload = uploadsByPerson.get(person.id)
    if (
      !PERSON_ID_PATTERN.test(person.id)
      || !upload
      || person.avatarKey !== upload.object_key
      || person.avatarSha256 !== upload.sha256
      || person.avatarWidth !== person.avatarHeight
      || person.avatarWidth < 1
      || !/^[a-f0-9]{64}$/.test(person.avatarSha256)
      || !person.avatarKey.endsWith(
        `/avatar-${person.avatarSha256.slice(0, 20)}.webp`
      )
    ) {
      throw new Error(`Export contains invalid avatar metadata for ${person.id}`)
    }
    if (avatarKeys.has(person.avatarKey)) {
      throw new Error("Export contains duplicate avatar object keys")
    }
    avatarKeys.add(person.avatarKey)
  }
  const mixedClusters = database
    .prepare(
      `SELECT cluster_id
       FROM faces
       WHERE status='labeled'
       GROUP BY cluster_id
       HAVING count(DISTINCT person_id) != 1
       LIMIT 1`
    )
    .get()
  if (mixedClusters) throw new Error("A labeled cluster contains mixed person IDs")
  if (!artifact.clusterRunKey) throw new Error("Face clustering has not completed")
}

function createSql(artifact) {
  const lines = [
    "\\set ON_ERROR_STOP on",
    "BEGIN;",
    "",
    "-- Apply database/002_photo_people.sql before this authoritative import.",
  ]
  for (const person of artifact.people) {
    lines.push(
      "INSERT INTO wedding_photos.people "
        + "(id, album_id, slug, display_name, avatar_key, avatar_sha256, "
        + "avatar_width, avatar_height) VALUES ("
        + `${sqlString(person.id)}, ${sqlString(artifact.albumId)}, `
        + `${sqlString(person.slug)}, ${sqlString(person.displayName)}, `
        + `${sqlString(person.avatarKey)}, ${sqlString(person.avatarSha256)}, `
        + `${person.avatarWidth}, ${person.avatarHeight}) `
        + "ON CONFLICT (id) DO UPDATE SET "
        + "slug=EXCLUDED.slug, display_name=EXCLUDED.display_name, "
        + "avatar_key=EXCLUDED.avatar_key, avatar_sha256=EXCLUDED.avatar_sha256, "
        + "avatar_width=EXCLUDED.avatar_width, "
        + "avatar_height=EXCLUDED.avatar_height, updated_at=now();"
    )
  }
  lines.push(
    "",
    "CREATE TEMP TABLE wedding_photo_people_import (",
    "  photo_id text NOT NULL,",
    "  person_id text NOT NULL,",
    "  PRIMARY KEY (photo_id, person_id)",
    ") ON COMMIT DROP;"
  )
  const chunkSize = 500
  for (let index = 0; index < artifact.photoPeople.length; index += chunkSize) {
    const chunk = artifact.photoPeople.slice(index, index + chunkSize)
    if (!chunk.length) continue
    lines.push(
      "INSERT INTO wedding_photo_people_import (photo_id, person_id) VALUES",
      `${chunk
        .map((entry) => `  (${sqlString(entry.photoId)}, ${sqlString(entry.personId)})`)
        .join(",\n")};`
    )
  }
  lines.push(
    "",
    "DO $face_import_guard$",
    "BEGIN",
    "  IF NOT EXISTS (",
    "    SELECT 1 FROM wedding_photos.import_runs",
    `    WHERE album_id=${sqlString(artifact.albumId)}`,
    "      AND status='completed'",
    `      AND manifest_sha256=${sqlString(artifact.sourceManifestSha256)}`,
    "  ) THEN",
    "    RAISE EXCEPTION 'The reviewed face export does not match a completed photo import';",
    "  END IF;",
    "",
    "  IF EXISTS (",
    "    SELECT 1",
    "    FROM wedding_photo_people_import incoming",
    "    LEFT JOIN wedding_photos.photos ph ON ph.id=incoming.photo_id",
    `    WHERE ph.id IS NULL OR ph.album_id<>${sqlString(artifact.albumId)}`,
    "  ) THEN",
    "    RAISE EXCEPTION 'The reviewed face export contains a photo outside its album';",
    "  END IF;",
    "END",
    "$face_import_guard$;",
    "",
    "DELETE FROM wedding_photos.photo_people pp",
    "USING wedding_photos.photos ph",
    `WHERE pp.photo_id=ph.id AND ph.album_id=${sqlString(artifact.albumId)}`,
    "  AND NOT EXISTS (",
    "    SELECT 1 FROM wedding_photo_people_import incoming",
    "    WHERE incoming.photo_id=pp.photo_id AND incoming.person_id=pp.person_id",
    "  );",
    "",
    "INSERT INTO wedding_photos.photo_people (photo_id, person_id)",
    "SELECT photo_id, person_id FROM wedding_photo_people_import",
    "ON CONFLICT (photo_id, person_id) DO NOTHING;",
    "",
    "DELETE FROM wedding_photos.people pe",
    `WHERE pe.album_id=${sqlString(artifact.albumId)}`,
    "  AND NOT EXISTS (",
    `    SELECT 1 FROM (VALUES ${artifact.people.length
      ? artifact.people.map((person) => `(${sqlString(person.id)})`).join(",")
      : "(NULL::text)"
    }) AS retained(id) WHERE retained.id=pe.id`,
    "  );",
    "",
    "DO $face_import_result_guard$",
    "DECLARE",
    "  imported_people bigint;",
    "  imported_links bigint;",
    "BEGIN",
    "  SELECT count(*) INTO imported_people",
    "  FROM wedding_photos.people",
    `  WHERE album_id=${sqlString(artifact.albumId)}`,
    "    AND avatar_key IS NOT NULL",
    "    AND avatar_sha256 IS NOT NULL",
    "    AND avatar_width IS NOT NULL",
    "    AND avatar_height IS NOT NULL;",
    "",
    "  SELECT count(*) INTO imported_links",
    "  FROM wedding_photos.photo_people pp",
    "  JOIN wedding_photos.photos ph ON ph.id=pp.photo_id",
    `  WHERE ph.album_id=${sqlString(artifact.albumId)};`,
    "",
    `  IF imported_people<>${artifact.people.length} THEN`,
    "    RAISE EXCEPTION 'Person import count mismatch: found %, expected %',",
    `      imported_people, ${artifact.people.length};`,
    "  END IF;",
    `  IF imported_links<>${artifact.photoPeople.length} THEN`,
    "    RAISE EXCEPTION 'Photo/person import count mismatch: found %, expected %',",
    `      imported_links, ${artifact.photoPeople.length};`,
    "  END IF;",
    "END",
    "$face_import_result_guard$;",
    "",
    "COMMIT;",
    "",
    `-- source_manifest_sha256=${artifact.sourceManifestSha256}`,
    `-- artifact_sha256=${artifact.artifactSha256}`,
    "",
  )
  return `${lines.join("\n")}\n`
}

function parseArguments(arguments_) {
  const options = {
    workspace: DEFAULT_WORKSPACE,
    output: undefined,
    apply: false,
    allowIncomplete: false,
  }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--workspace") {
      options.workspace = arguments_[index + 1]
      index += 1
    } else if (argument === "--output") {
      options.output = arguments_[index + 1]
      index += 1
    } else if (argument === "--apply") {
      options.apply = true
    } else if (argument === "--allow-incomplete") {
      options.allowIncomplete = true
    } else if (argument === "--help") {
      console.log(
        "Usage: npm run faces:export -- "
          + "[--allow-incomplete] [--apply] [--workspace PATH] [--output PATH]"
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (options.apply && options.allowIncomplete) {
    throw new Error("--apply cannot be combined with --allow-incomplete")
  }
  return options
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function avatarCropSide(configJson) {
  let config
  try {
    config = JSON.parse(configJson)
  } catch {
    throw new Error("Face workspace configuration is invalid")
  }
  const side = config?.crop?.side_px
  if (!Number.isSafeInteger(side) || side < 64 || side > 1_024) {
    throw new Error("Face workspace avatar crop size is invalid")
  }
  return side
}

async function validateAvatarCrop(workspace, person, expectedSide) {
  if (!PERSON_ID_PATTERN.test(person.id)) {
    throw new Error(`Cannot create a safe avatar key for person ${person.id}`)
  }
  if (
    typeof person.crop_relpath !== "string"
    || !person.crop_relpath.startsWith("crops/")
  ) {
    throw new Error(`Avatar crop path is invalid for ${person.id}`)
  }
  const cropRoot = await realpath(path.join(workspace, "crops"))
  if (!isChildPath(workspace, cropRoot)) {
    throw new Error("Avatar crop directory resolves outside the private workspace")
  }
  const candidatePath = path.resolve(workspace, person.crop_relpath)
  const localPath = await realpath(candidatePath).catch(() => null)
  if (!localPath || !isChildPath(cropRoot, localPath)) {
    throw new Error(`Avatar crop is missing or outside the private workspace for ${person.id}`)
  }
  const info = await stat(localPath)
  if (!info.isFile() || info.size < 1) {
    throw new Error(`Avatar crop is not a regular file for ${person.id}`)
  }
  const bytes = await readFile(localPath)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (sha256 !== person.crop_sha256) {
    throw new Error(`Avatar crop SHA-256 changed for ${person.id}`)
  }
  let metadata
  try {
    metadata = await sharp(bytes, { failOn: "warning" }).metadata()
  } catch {
    throw new Error(`Avatar crop is not a valid WebP image for ${person.id}`)
  }
  if (
    metadata.format !== "webp"
    || metadata.width !== expectedSide
    || metadata.height !== expectedSide
  ) {
    throw new Error(
      `Avatar crop must be a ${expectedSide}x${expectedSide} WebP for ${person.id}`
    )
  }
  return {
    objectKey:
      `${AVATAR_PREFIX}/${person.id}/avatar-${sha256.slice(0, 20)}.webp`,
    localPath,
    sha256,
    width: metadata.width,
    height: metadata.height,
    bytes: info.size,
  }
}

function isChildPath(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return Boolean(relative)
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
}

function assertWorkspace(workspace) {
  const allowedRoot = path.join(REPO_ROOT, ".media-staging")
  const relative = path.relative(allowedRoot, workspace)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Workspace must be inside the ignored .media-staging directory")
  }
}

async function writePrivateAtomic(destination, content) {
  const temporary = `${destination}.partial-${process.pid}`
  await rm(temporary, { force: true })
  try {
    const file = await open(temporary, "wx", 0o600)
    try {
      await file.writeFile(content, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, destination)
    await chmod(destination, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}
