#!/usr/bin/env node

import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TOOL_DIRECTORY, "../..")
const DEFAULT_WORKSPACE = path.join(REPO_ROOT, ".media-staging", "faces")

main().catch((error) => {
  console.error(`Face export failed: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const workspace = path.resolve(options.workspace ?? DEFAULT_WORKSPACE)
  assertWorkspace(workspace)
  const database = new DatabaseSync(path.join(workspace, "faces.sqlite3"), {
    readOnly: true,
    timeout: 5_000,
  })
  database.exec("PRAGMA foreign_keys = ON")
  let artifact
  database.exec("BEGIN")
  try {
    artifact = buildArtifact(database)
    validateArtifact(database, artifact, options.allowIncomplete)
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
    artifactSha256: artifact.artifactSha256,
  }
  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2))
    database.close()
    return
  }
  if (artifact.review.unreviewedClusters > 0) {
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
  database.close()
  console.log(JSON.stringify({ ...summary, outputDirectory }, null, 2))
}

function buildArtifact(database) {
  const workspace = database.prepare("SELECT * FROM workspace WHERE id=1").get()
  if (!workspace) throw new Error("Face workspace metadata is missing")
  const people = database
    .prepare(
      `SELECT pe.id, pe.display_name, count(DISTINCT f.photo_id) AS photo_count
       FROM people pe
       JOIN faces f ON f.person_id=pe.id AND f.status='labeled'
       GROUP BY pe.id
       ORDER BY pe.id`
    )
    .all()
    .map((person) => ({
      id: person.id,
      slug: `person-${person.id.replace(/^person_/, "").slice(0, 12)}`,
      displayName: person.display_name,
      photoCount: Number(person.photo_count),
    }))
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
    schemaVersion: 1,
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
    ...base,
    artifactSha256: createHash("sha256")
      .update(canonicalJson(base))
      .digest("hex"),
  }
}

function validateArtifact(database, artifact, allowIncomplete) {
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
      `INSERT INTO wedding_photos.people (id, album_id, slug, display_name) VALUES (`
        + `${sqlString(person.id)}, ${sqlString(artifact.albumId)}, `
        + `${sqlString(person.slug)}, ${sqlString(person.displayName)}) `
        + "ON CONFLICT (id) DO UPDATE SET "
        + "slug=EXCLUDED.slug, display_name=EXCLUDED.display_name, updated_at=now();"
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
