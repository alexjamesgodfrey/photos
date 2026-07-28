#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

import { createFaceStore } from "./store.mjs"

const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TOOL_DIRECTORY, "../..")
const ALLOWED_WORKSPACE_ROOT = path.join(REPO_ROOT, ".media-staging")
const DEFAULT_WORKSPACE = path.join(ALLOWED_WORKSPACE_ROOT, "faces")
const STATUSES = ["unreviewed", "labeled", "unknown", "ignored"]

export function inspectFaceDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 5_000,
  })
  try {
    database.exec("PRAGMA foreign_keys = ON")
    database.exec("PRAGMA busy_timeout = 5000")
    const clusters = statusCounts(database, "clusters")
    const faces = statusCounts(database, "faces")
    const targetState = database
      .prepare(
        `SELECT
           count(DISTINCT c.id) AS unreviewed_clusters,
           count(f.id) AS target_faces,
           sum(CASE WHEN f.status='unreviewed' THEN 1 ELSE 0 END)
             AS unreviewed_faces,
           sum(CASE WHEN f.status='labeled' THEN 1 ELSE 0 END)
             AS labeled_faces,
           sum(CASE WHEN f.status='unknown' THEN 1 ELSE 0 END)
             AS unknown_faces,
           sum(CASE WHEN f.status='ignored' THEN 1 ELSE 0 END)
             AS ignored_faces
         FROM clusters c
         LEFT JOIN faces f ON f.cluster_id=c.id
         WHERE c.status='unreviewed'`
      )
      .get()
    const emptyTargetClusters = Number(
      database
        .prepare(
          `SELECT count(*) AS count FROM (
             SELECT c.id
             FROM clusters c
             LEFT JOIN faces f ON f.cluster_id=c.id
             WHERE c.status='unreviewed'
             GROUP BY c.id
             HAVING count(f.id)=0
           )`
        )
        .get().count
    )
    const unreviewedFacesOutsideTargets = Number(
      database
        .prepare(
          `SELECT count(*) AS count
           FROM faces f
           LEFT JOIN clusters c ON c.id=f.cluster_id
           WHERE f.status='unreviewed'
             AND (c.id IS NULL OR c.status!='unreviewed')`
        )
        .get().count
    )
    const action = database
      .prepare(
        `SELECT
           (SELECT count(*) FROM actions WHERE undone_at IS NULL)
             AS active_actions,
           (SELECT count(*) FROM actions WHERE undone_at IS NOT NULL)
             AS undone_actions,
           (SELECT max(id) FROM actions) AS max_action_id,
           (SELECT action_high_watermark FROM workspace WHERE id=1)
             AS action_high_watermark`
      )
      .get()
    const integrity = database
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => String(row.integrity_check))
    const foreignKeyViolations = database
      .prepare("PRAGMA foreign_key_check")
      .all()
    return {
      clusters,
      faces,
      target: {
        clusters: Number(targetState.unreviewed_clusters ?? 0),
        faces: Number(targetState.target_faces ?? 0),
        unreviewedFaces: Number(targetState.unreviewed_faces ?? 0),
        labeledFaces: Number(targetState.labeled_faces ?? 0),
        unknownFaces: Number(targetState.unknown_faces ?? 0),
        ignoredFaces: Number(targetState.ignored_faces ?? 0),
        emptyClusters: emptyTargetClusters,
        unreviewedFacesOutsideTargets,
      },
      actions: {
        active: Number(action.active_actions ?? 0),
        undone: Number(action.undone_actions ?? 0),
        maxId: Number(action.max_action_id ?? 0),
        highWatermark: Number(action.action_high_watermark ?? 0),
      },
      protectedIdentityHash: protectedIdentityHash(database),
      integrity,
      foreignKeyViolationCount: foreignKeyViolations.length,
    }
  } finally {
    database.close()
  }
}

export async function runIgnoreUnreviewed(options = {}) {
  const workspace = path.resolve(options.workspace ?? DEFAULT_WORKSPACE)
  assertWorkspace(workspace)
  const databasePath = path.join(workspace, "faces.sqlite3")
  const databaseStat = await stat(databasePath).catch(() => null)
  if (!databaseStat?.isFile()) {
    throw new Error("Face database is missing")
  }

  const before = inspectFaceDatabase(databasePath)
  assertSafePreflight(before)
  if (!options.apply) {
    return {
      applied: false,
      databasePath,
      before: reportCounts(before),
    }
  }

  const store = createFaceStore(databasePath)
  let backupPath
  let mutation
  try {
    store.checkpoint()
    backupPath = await createBackup(workspace, databasePath)
    const backup = inspectFaceDatabase(backupPath)
    assertBackup(before, backup)

    mutation = store.ignoreUnreviewedClusters({
      clientMutationId:
        `ignore_all_${randomUUID().replaceAll("-", "")}`,
    })
    store.checkpoint()
  } finally {
    store.close()
  }

  const after = inspectFaceDatabase(databasePath)
  assertSafeResult(before, after, mutation)
  return {
    applied: true,
    databasePath,
    backupPath,
    actionId: mutation.actionId ?? null,
    actionType: mutation.noOp
      ? null
      : "ignore_all_unreviewed_clusters",
    mutation,
    before: reportCounts(before),
    after: reportCounts(after),
    checks: {
      integrity: after.integrity,
      foreignKeyViolationCount: after.foreignKeyViolationCount,
      protectedIdentityHashUnchanged:
        before.protectedIdentityHash === after.protectedIdentityHash,
      actionHighWatermark: after.actions.highWatermark,
    },
  }
}

function statusCounts(database, table) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]))
  for (const row of database
    .prepare(`SELECT status, count(*) AS count FROM ${table} GROUP BY status`)
    .all()) {
    counts[row.status] = Number(row.count)
  }
  return counts
}

function protectedIdentityHash(database) {
  const payload = {
    people: database
      .prepare(
        `SELECT id, display_name, name_key, created_at, updated_at
         FROM people ORDER BY id`
      )
      .all(),
    clusters: database
      .prepare(
        `SELECT id, status, person_id, revision, reviewed_at, updated_at
         FROM clusters
         WHERE status IN ('labeled','unknown')
         ORDER BY id`
      )
      .all(),
    faces: database
      .prepare(
        `SELECT id, cluster_id, person_id, status, revision, updated_at
         FROM faces
         WHERE status IN ('labeled','unknown')
         ORDER BY id`
      )
      .all(),
  }
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
}

function assertSafePreflight(inspection) {
  if (
    inspection.integrity.length !== 1
    || inspection.integrity[0] !== "ok"
  ) {
    throw new Error("SQLite integrity_check failed; no rows were changed")
  }
  if (inspection.foreignKeyViolationCount) {
    throw new Error("SQLite foreign_key_check failed; no rows were changed")
  }
  if (inspection.target.emptyClusters) {
    throw new Error(
      "Unreviewed clusters without faces were found; no rows were changed"
    )
  }
  if (
    inspection.target.labeledFaces
    || inspection.target.unknownFaces
    || inspection.target.ignoredFaces
  ) {
    throw new Error(
      "Unreviewed clusters contain mixed face statuses; no rows were changed"
    )
  }
  if (inspection.target.unreviewedFacesOutsideTargets) {
    throw new Error(
      "Unreviewed faces exist outside unreviewed clusters; no rows were changed"
    )
  }
  if (
    inspection.target.faces !== inspection.target.unreviewedFaces
    || inspection.target.clusters !== inspection.clusters.unreviewed
  ) {
    throw new Error(
      "Unreviewed cluster counts are inconsistent; no rows were changed"
    )
  }
}

async function createBackup(workspace, databasePath) {
  const backupDirectory = path.join(workspace, "backups")
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
  await chmod(backupDirectory, 0o700)
  const stamp = new Date().toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-")
  const filename = `faces-before-ignore-unreviewed-${stamp}.sqlite3`
  const destination = path.join(backupDirectory, filename)
  const temporary = path.join(
    backupDirectory,
    `.${filename}.${randomUUID()}.tmp`
  )
  try {
    await copyFile(databasePath, temporary)
    await chmod(temporary, 0o600)
    const handle = await open(temporary, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
    await chmod(destination, 0o600)
    return destination
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function assertBackup(before, backup) {
  if (
    JSON.stringify(before.clusters) !== JSON.stringify(backup.clusters)
    || JSON.stringify(before.faces) !== JSON.stringify(backup.faces)
    || JSON.stringify(before.actions) !== JSON.stringify(backup.actions)
    || before.protectedIdentityHash !== backup.protectedIdentityHash
    || backup.integrity.length !== 1
    || backup.integrity[0] !== "ok"
    || backup.foreignKeyViolationCount
  ) {
    throw new Error("The pre-mutation SQLite backup did not verify")
  }
}

function assertSafeResult(before, after, mutation) {
  if (after.integrity.length !== 1 || after.integrity[0] !== "ok") {
    throw new Error("Post-mutation SQLite integrity_check failed")
  }
  if (after.foreignKeyViolationCount) {
    throw new Error("Post-mutation SQLite foreign_key_check failed")
  }
  if (before.protectedIdentityHash !== after.protectedIdentityHash) {
    throw new Error("Labeled or unknown identity data changed unexpectedly")
  }
  if (
    after.clusters.labeled !== before.clusters.labeled
    || after.clusters.unknown !== before.clusters.unknown
    || after.faces.labeled !== before.faces.labeled
    || after.faces.unknown !== before.faces.unknown
  ) {
    throw new Error("Protected labeled or unknown counts changed unexpectedly")
  }
  if (after.clusters.unreviewed || after.faces.unreviewed) {
    throw new Error("Some unreviewed clusters or faces remain")
  }
  if (
    after.clusters.ignored
      !== before.clusters.ignored + before.clusters.unreviewed
    || after.faces.ignored
      !== before.faces.ignored + before.faces.unreviewed
  ) {
    throw new Error("Ignored counts do not match the preflight target")
  }
  if (!mutation.noOp) {
    if (
      mutation.targetClusterCount !== before.clusters.unreviewed
      || mutation.ignoredFaceCount !== before.faces.unreviewed
      || after.actions.highWatermark !== mutation.actionId
      || after.actions.maxId !== mutation.actionId
      || after.actions.active !== before.actions.active + 1
    ) {
      throw new Error("The recoverable action log did not advance as expected")
    }
  }
}

function reportCounts(inspection) {
  return {
    clusters: inspection.clusters,
    faces: inspection.faces,
    actions: inspection.actions,
  }
}

function assertWorkspace(workspace) {
  const relation = path.relative(ALLOWED_WORKSPACE_ROOT, workspace)
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(
      "Workspace must be inside the ignored .media-staging directory"
    )
  }
}

function parseArguments(arguments_) {
  const options = {
    workspace: DEFAULT_WORKSPACE,
    apply: false,
  }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--workspace") {
      options.workspace = arguments_[index + 1]
      index += 1
    } else if (argument === "--apply") {
      options.apply = true
    } else if (argument === "--help") {
      console.log(
        "Usage: npm run faces:ignore-unreviewed -- "
          + "[--workspace PATH] [--apply]"
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
  const result = await runIgnoreUnreviewed(options).catch((error) => {
    console.error(`Unable to ignore unreviewed clusters: ${error.message}`)
    process.exit(1)
  })
  console.log(JSON.stringify(result, null, 2))
  if (!options.apply) {
    console.log(
      "Preview only. Re-run with --apply to create a backup and record one "
        + "undoable action."
    )
  }
}
