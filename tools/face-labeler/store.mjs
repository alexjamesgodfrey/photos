import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

const CLUSTER_STATES = new Set(["unreviewed", "labeled", "unknown", "ignored"])
const FIRST_NAME_ALIASES = new Map([
  ["henry", "Henry5"],
  ["mau", "Mauricio"],
])
const MUTABLE_FACE_COLUMNS = [
  "id",
  "cluster_id",
  "person_id",
  "status",
  "revision",
  "updated_at",
]
const MUTABLE_CLUSTER_COLUMNS = [
  "id",
  "origin",
  "status",
  "person_id",
  "representative_face_id",
  "revision",
  "reviewed_at",
  "created_at",
  "updated_at",
]
const PERSON_COLUMNS = [
  "id",
  "display_name",
  "name_key",
  "created_at",
  "updated_at",
]
const CLUSTER_SUGGESTION_COLUMNS = [
  "cluster_id_a",
  "cluster_id_b",
  "similarity_max",
  "similarity_median",
  "similarity_min",
  "status",
  "created_at",
]

export function createFaceStore(databasePath, options = {}) {
  const database = new DatabaseSync(databasePath, {
    readOnly: options.readOnly ?? false,
    timeout: 5_000,
  })
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("PRAGMA busy_timeout = 5000")
  if (!options.readOnly) {
    database.exec("PRAGMA journal_mode = WAL")
    database.exec("PRAGMA synchronous = FULL")
  }

  return {
    close: () => database.close(),
    checkpoint: () => database.exec("PRAGMA wal_checkpoint(FULL)"),
    bootstrap: ({ status = "unreviewed", query = "" } = {}) =>
      getBootstrap(database, status, query),
    cluster: (clusterId) => getCluster(database, clusterId),
    crop: (faceId) =>
      database
        .prepare("SELECT crop_relpath FROM faces WHERE id=?")
        .get(validateId(faceId, "face")),
    photo: (photoId) =>
      database
        .prepare("SELECT display_relpath FROM photos WHERE id=?")
        .get(validateId(photoId, "photo")),
    exportPreview: () => getExportPreview(database),
    labelCluster: (clusterId, body = {}) =>
      labelCluster(database, clusterId, body),
    batchLabelClusters: (body = {}) => batchLabelClusters(database, body),
    dispositionCluster: (clusterId, state, body = {}) =>
      dispositionCluster(database, clusterId, state, body),
    dispositionFace: (faceId, state, body = {}) =>
      dispositionFace(database, faceId, state, body),
    splitCluster: (clusterId, body = {}) =>
      splitCluster(database, clusterId, body),
    mergeClusters: (body = {}) => mergeClusters(database, body),
    undo: () => undoLastAction(database),
  }
}

function getBootstrap(database, requestedStatus, rawQuery) {
  const status = requestedStatus === "all" ? "all" : validateState(requestedStatus)
  const query = String(rawQuery ?? "").trim().slice(0, 120)
  const where = []
  const parameters = []
  if (status !== "all") {
    where.push("c.status = ?")
    parameters.push(status)
  }
  if (query) {
    where.push("(coalesce(pe.display_name, '') LIKE ? ESCAPE '\\' OR c.id LIKE ? ESCAPE '\\')")
    const escaped = `%${escapeLike(query)}%`
    parameters.push(escaped, escaped)
  }
  const clusters = database
    .prepare(
      `${clusterSummarySql()}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       GROUP BY c.id
       ORDER BY
         CASE c.status
           WHEN 'unreviewed' THEN 0
           WHEN 'labeled' THEN 1
           WHEN 'unknown' THEN 2
           ELSE 3
         END,
         count(f.id) DESC,
         min(ph.album_position),
         c.id`
    )
    .all(...parameters)
    .map(serializeCluster)

  const summaryRow = database
    .prepare(
      `SELECT
        (SELECT count(*) FROM photos) AS photos,
        (SELECT count(*) FROM photos WHERE scan_status='complete') AS scanned_photos,
        (SELECT count(*) FROM faces) AS total_faces,
        (SELECT count(*) FROM faces WHERE quality='clusterable') AS clusterable_faces,
        (SELECT count(*) FROM faces WHERE quality='manual_only') AS manual_only_faces,
        (SELECT count(*) FROM clusters WHERE status='unreviewed') AS unreviewed_clusters,
        (SELECT count(*) FROM clusters WHERE status='labeled') AS labeled_clusters,
        (SELECT count(*) FROM clusters WHERE status='unknown') AS unknown_clusters,
        (SELECT count(*) FROM clusters WHERE status='ignored') AS ignored_clusters,
        (SELECT count(*) FROM faces WHERE status='labeled') AS labeled_faces,
        (SELECT count(*) FROM faces WHERE status='unknown') AS unknown_faces,
        (SELECT count(*) FROM faces WHERE status='ignored') AS ignored_faces,
        (SELECT count(*) FROM faces WHERE status='unreviewed') AS remaining_faces`
    )
    .get()
  return {
    summary: {
      photos: number(summaryRow.photos),
      scannedPhotos: number(summaryRow.scanned_photos),
      totalFaces: number(summaryRow.total_faces),
      clusterableFaces: number(summaryRow.clusterable_faces),
      manualOnlyFaces: number(summaryRow.manual_only_faces),
      unreviewedClusters: number(summaryRow.unreviewed_clusters),
      labeledClusters: number(summaryRow.labeled_clusters),
      unknownClusters: number(summaryRow.unknown_clusters),
      ignoredClusters: number(summaryRow.ignored_clusters),
      labeledFaces: number(summaryRow.labeled_faces),
      unknownFaces: number(summaryRow.unknown_faces),
      ignoredFaces: number(summaryRow.ignored_faces),
      remainingFaces: number(summaryRow.remaining_faces),
    },
    clusters,
  }
}

function getCluster(database, clusterId) {
  const id = validateId(clusterId, "cluster")
  const summary = database
    .prepare(`${clusterSummarySql()} WHERE c.id=? GROUP BY c.id`)
    .get(id)
  if (!summary) return null
  const faces = database
    .prepare(
      `SELECT
        f.id, f.photo_id, f.cluster_id, f.person_id, f.ordinal,
        f.bbox_x, f.bbox_y, f.bbox_width, f.bbox_height,
        f.detection_score, f.width_px, f.height_px, f.quality,
        f.quality_score, f.status, f.revision, ph.album_position
       FROM faces f
       JOIN photos ph ON ph.id=f.photo_id
       WHERE f.cluster_id=?
       ORDER BY ph.album_position, f.ordinal, f.id`
    )
    .all(id)
    .map((face) => ({
      id: face.id,
      photoId: face.photo_id,
      clusterId: face.cluster_id,
      personId: face.person_id,
      albumPosition: number(face.album_position),
      confidence: number(face.detection_score),
      quality: face.quality,
      qualityScore: number(face.quality_score),
      ignored: face.status === "ignored",
      status: face.status,
      revision: number(face.revision),
      dimensions: {
        width: number(face.width_px),
        height: number(face.height_px),
      },
      bbox: {
        x: number(face.bbox_x),
        y: number(face.bbox_y),
        width: number(face.bbox_width),
        height: number(face.bbox_height),
      },
    }))
  const suggestions = database
    .prepare(
      `SELECT
        CASE WHEN s.cluster_id_a=? THEN s.cluster_id_b ELSE s.cluster_id_a END AS cluster_id,
        s.similarity_max, s.similarity_median, s.similarity_min,
        c.status, c.person_id, pe.display_name, c.representative_face_id
       FROM cluster_suggestions s
       JOIN clusters c ON c.id=CASE
         WHEN s.cluster_id_a=? THEN s.cluster_id_b ELSE s.cluster_id_a END
       LEFT JOIN people pe ON pe.id=c.person_id
       WHERE (s.cluster_id_a=? OR s.cluster_id_b=?) AND s.status='pending'
       ORDER BY s.similarity_max DESC
       LIMIT 8`
    )
    .all(id, id, id, id)
    .map((suggestion) => ({
      clusterId: suggestion.cluster_id,
      personId: suggestion.person_id,
      displayName: suggestion.display_name,
      status: suggestion.status,
      representativeFaceId: suggestion.representative_face_id,
      similarity: {
        max: number(suggestion.similarity_max),
        median: number(suggestion.similarity_median),
        min: number(suggestion.similarity_min),
      },
    }))
  return { ...serializeCluster(summary), faces, suggestions }
}

function getExportPreview(database) {
  const people = database
    .prepare(
      `SELECT pe.id, pe.display_name, count(DISTINCT f.photo_id) AS photo_count,
              count(f.id) AS face_count
       FROM people pe
       JOIN faces f ON f.person_id=pe.id AND f.status='labeled'
       GROUP BY pe.id
       ORDER BY pe.display_name COLLATE NOCASE, pe.id`
    )
    .all()
    .map((person) => ({
      id: person.id,
      displayName: person.display_name,
      photoCount: number(person.photo_count),
      faceCount: number(person.face_count),
    }))
  const photoPeople = number(
    database
      .prepare(
        "SELECT count(*) AS count FROM "
          + "(SELECT DISTINCT photo_id, person_id FROM faces "
          + "WHERE status='labeled' AND person_id IS NOT NULL)"
      )
      .get().count
  )
  return {
    people,
    photoPeople,
    unreviewedClusters: number(
      database
        .prepare("SELECT count(*) AS count FROM clusters WHERE status='unreviewed'")
        .get().count
    ),
    unknownFaces: number(
      database
        .prepare("SELECT count(*) AS count FROM faces WHERE status='unknown'")
        .get().count
    ),
    ignoredFaces: number(
      database
        .prepare("SELECT count(*) AS count FROM faces WHERE status='ignored'")
        .get().count
    ),
  }
}

function labelCluster(database, rawClusterId, body) {
  const clusterId = validateId(rawClusterId, "cluster")
  const displayName = normalizeDisplayName(body.name)
  const existingPerson = database
    .prepare("SELECT id FROM people WHERE name_key=?")
    .get(normalizeNameKey(displayName))
  const existingCluster = requireCluster(database, clusterId)
  if (
    existingPerson
    && existingCluster.status === "labeled"
    && existingCluster.person_id === existingPerson.id
    && !database
      .prepare(
        "SELECT 1 FROM faces WHERE cluster_id=? "
          + "AND status NOT IN ('ignored','unknown') "
          + "AND (status!='labeled' OR person_id IS NOT ?) LIMIT 1"
      )
      .get(clusterId, existingPerson.id)
  ) {
    return { noOp: true, ...getCluster(database, clusterId) }
  }
  return mutate(database, body, "label_cluster", () => {
    const cluster = requireCluster(database, clusterId)
    const faces = snapshotFaces(database, facesForClusters(database, [clusterId]))
    const clusters = snapshotClusters(database, [clusterId])
    const includeUnknown = cluster.status === "unknown"
    const eligible = number(
      database
        .prepare(
          "SELECT count(*) AS count FROM faces WHERE cluster_id=? "
            + "AND status!='ignored' "
            + (includeUnknown ? "" : "AND status!='unknown'")
        )
        .get(clusterId).count
    )
    if (!eligible) {
      throw conflict("Recover at least one face before naming this group")
    }
    const nameKey = normalizeNameKey(displayName)
    let person = database
      .prepare("SELECT * FROM people WHERE name_key=?")
      .get(nameKey)
    const deletePeople = []
    if (!person) {
      const now = utcNow()
      const personId = `person_${randomUUID().replaceAll("-", "")}`
      database
        .prepare(
          "INSERT INTO people (id, display_name, name_key, created_at, updated_at) "
            + "VALUES (?,?,?,?,?)"
        )
        .run(personId, displayName, nameKey, now, now)
      person = database.prepare("SELECT * FROM people WHERE id=?").get(personId)
      deletePeople.push(personId)
    }
    const now = utcNow()
    database
      .prepare(
        "UPDATE faces SET person_id=?, status='labeled', revision=revision+1, "
          + "updated_at=? WHERE cluster_id=? AND status!='ignored' "
          + (includeUnknown ? "" : "AND status!='unknown'")
      )
      .run(person.id, now, clusterId)
    recomputeCluster(database, clusterId, now)
    return {
      payload: { clusterId, personId: person.id, displayName: person.display_name },
      inverse: {
        faces,
        clusters,
        people: [],
        deleteClusters: [],
        deletePeople,
        deleteCannotLinks: [],
      },
      result: getCluster(database, clusterId),
      beforeRevision: number(cluster.revision),
    }
  })
}

function batchLabelClusters(database, body) {
  const personId = validateId(body.personId, "person")
  const clusterIds = requiredUniqueIds(body.clusterIds, "cluster")
  return mutate(database, body, "batch_label_clusters", () => {
    const person = database.prepare("SELECT * FROM people WHERE id=?").get(personId)
    if (!person) throw notFound("Person")

    const clusters = clusterIds.map((clusterId) =>
      requireCluster(database, clusterId)
    )
    const updatedClusterIds = []
    const labelableFace = database.prepare(
      "SELECT 1 FROM faces WHERE cluster_id=? "
        + "AND status NOT IN ('ignored','unknown') LIMIT 1"
    )
    const conflictingFace = database.prepare(
      "SELECT 1 FROM faces WHERE cluster_id=? AND status='labeled' "
        + "AND person_id IS NOT ? LIMIT 1"
    )
    for (const cluster of clusters) {
      if (cluster.status === "ignored" || cluster.status === "unknown") {
        throw conflict(
          "Recover ignored or unknown clusters before batch labeling"
        )
      }
      if (
        cluster.status === "labeled"
        && cluster.person_id !== person.id
      ) {
        throw conflict("A selected cluster belongs to another person")
      }
      if (!labelableFace.get(cluster.id)) {
        throw conflict("Recover at least one face before batch labeling")
      }
      if (conflictingFace.get(cluster.id, person.id)) {
        throw conflict("A selected face belongs to another person")
      }
      if (cluster.status === "unreviewed") {
        updatedClusterIds.push(cluster.id)
      }
    }

    const result = {
      personId: person.id,
      displayName: person.display_name,
      updatedClusterIds,
      updatedCount: updatedClusterIds.length,
    }
    if (!updatedClusterIds.length) {
      return {
        skipAction: true,
        result: { noOp: true, ...result },
      }
    }

    const faceIds = facesForClusters(database, updatedClusterIds)
    const inverse = {
      faces: snapshotFaces(database, faceIds),
      clusters: snapshotClusters(database, updatedClusterIds),
      people: [],
      deleteClusters: [],
      deletePeople: [],
      deleteCannotLinks: [],
    }
    const now = utcNow()
    const labelFaces = database.prepare(
      "UPDATE faces SET person_id=?, status='labeled', "
        + "revision=revision+1, updated_at=? WHERE cluster_id=? "
        + "AND status NOT IN ('ignored','unknown') "
        + "AND (status!='labeled' OR person_id IS NOT ?)"
    )
    for (const clusterId of updatedClusterIds) {
      labelFaces.run(person.id, now, clusterId, person.id)
      recomputeCluster(database, clusterId, now)
    }
    return {
      payload: {
        personId: person.id,
        displayName: person.display_name,
        clusterIds,
        updatedClusterIds,
      },
      inverse,
      result,
    }
  })
}

function dispositionCluster(database, rawClusterId, rawState, body) {
  const clusterId = validateId(rawClusterId, "cluster")
  const state = validateDisposition(rawState)
  return mutate(database, body, `${state}_cluster`, () => {
    const cluster = requireCluster(database, clusterId)
    const faceIds = facesForClusters(database, [clusterId])
    const inverse = {
      faces: snapshotFaces(database, faceIds),
      clusters: snapshotClusters(database, [clusterId]),
      people: [],
      deleteClusters: [],
      deletePeople: [],
      deleteCannotLinks: [],
    }
    const now = utcNow()
    let predicate = ""
    if (state === "unknown") {
      predicate = " AND status!='ignored'"
    } else if (state === "unreviewed" && cluster.status === "unknown") {
      predicate = " AND status='unknown'"
    }
    database
      .prepare(
        "UPDATE faces SET person_id=NULL, status=?, revision=revision+1, "
          + `updated_at=? WHERE cluster_id=?${predicate}`
      )
      .run(state, now, clusterId)
    recomputeCluster(database, clusterId, now)
    return {
      payload: { clusterId, state },
      inverse,
      result: getCluster(database, clusterId),
    }
  })
}

function dispositionFace(database, rawFaceId, rawState, body) {
  const faceId = validateId(rawFaceId, "face")
  const state = validateDisposition(rawState)
  return mutate(database, body, `${state}_face`, () => {
    const face = database.prepare("SELECT * FROM faces WHERE id=?").get(faceId)
    if (!face) throw notFound("Face")
    const inverse = {
      faces: snapshotFaces(database, [faceId]),
      clusters: face.cluster_id
        ? snapshotClusters(database, [face.cluster_id])
        : [],
      people: [],
      deleteClusters: [],
      deletePeople: [],
      deleteCannotLinks: [],
    }
    const now = utcNow()
    database
      .prepare(
        "UPDATE faces SET person_id=NULL, status=?, revision=revision+1, "
          + "updated_at=? WHERE id=?"
      )
      .run(state, now, faceId)
    if (face.cluster_id) recomputeCluster(database, face.cluster_id, now)
    return {
      payload: { faceId, state },
      inverse,
      result: face.cluster_id ? getCluster(database, face.cluster_id) : null,
    }
  })
}

function splitCluster(database, rawClusterId, body) {
  const clusterId = validateId(rawClusterId, "cluster")
  const requestedFaceIds = uniqueIds(body.faceIds, "face")
  return mutate(database, body, "split_cluster", () => {
    requireCluster(database, clusterId)
    const allFaceIds = facesForClusters(database, [clusterId])
    const allFaces = new Set(allFaceIds)
    if (!requestedFaceIds.length || requestedFaceIds.length >= allFaceIds.length) {
      throw badRequest("Select at least one face, but not the entire cluster")
    }
    if (requestedFaceIds.some((faceId) => !allFaces.has(faceId))) {
      throw badRequest("Every selected face must belong to the active cluster")
    }
    const remainingFaceIds = allFaceIds.filter(
      (faceId) => !requestedFaceIds.includes(faceId)
    )
    const newClusterId = `c_manual_${randomUUID().replaceAll("-", "")}`
    const inverse = {
      faces: snapshotFaces(database, allFaceIds),
      clusters: snapshotClusters(database, [clusterId]),
      clusterSuggestions: snapshotClusterSuggestions(database, [clusterId]),
      people: [],
      deleteClusters: [newClusterId],
      deletePeople: [],
      deleteCannotLinks: [],
    }
    const now = utcNow()
    const representative = bestRepresentative(database, requestedFaceIds)
    database
      .prepare(
        "INSERT INTO clusters "
          + "(id, origin, status, representative_face_id, created_at, updated_at) "
          + "VALUES (?, 'manual', 'unreviewed', ?, ?, ?)"
      )
      .run(newClusterId, representative, now, now)
    const update = database.prepare(
      "UPDATE faces SET cluster_id=?, person_id=NULL, status='unreviewed', "
        + "revision=revision+1, updated_at=? WHERE id=?"
    )
    for (const faceId of requestedFaceIds) {
      update.run(newClusterId, now, faceId)
    }
    deleteClusterSuggestions(database, [clusterId, newClusterId])
    const cannotLink = database.prepare(
      "INSERT OR IGNORE INTO cannot_links "
        + "(face_id_a, face_id_b, reason, created_at) "
        + "VALUES (?,?, 'manual_split', ?)"
    )
    for (const selected of requestedFaceIds) {
      for (const remaining of remainingFaceIds) {
        const [faceA, faceB] = [selected, remaining].sort()
        const result = cannotLink.run(faceA, faceB, now)
        if (number(result.changes)) {
          inverse.deleteCannotLinks.push([faceA, faceB])
        }
      }
    }
    recomputeCluster(database, clusterId, now)
    recomputeCluster(database, newClusterId, now)
    return {
      payload: { clusterId, newClusterId, faceIds: requestedFaceIds },
      inverse,
      result: {
        source: getCluster(database, clusterId),
        created: getCluster(database, newClusterId),
      },
    }
  })
}

function mergeClusters(database, body) {
  const clusterIds = uniqueIds(body.clusterIds, "cluster").sort()
  if (clusterIds.length < 2) throw badRequest("Select at least two clusters")
  return mutate(database, body, "merge_clusters", () => {
    const clusters = clusterIds.map((clusterId) =>
      requireCluster(database, clusterId)
    )
    const people = new Set(
      clusters.map((cluster) => cluster.person_id).filter(Boolean)
    )
    if (people.size > 1) {
      throw conflict("Clusters already belong to different named people")
    }
    const faceIds = facesForClusters(database, clusterIds)
    if (hasCannotLinkAcrossClusters(database, clusterIds)) {
      throw conflict("These clusters contain faces that must remain separate")
    }
    const inverse = {
      faces: snapshotFaces(database, faceIds),
      clusters: snapshotClusters(database, clusterIds),
      clusterSuggestions: snapshotClusterSuggestions(database, clusterIds),
      people: [],
      deleteClusters: [],
      deletePeople: [],
      deleteCannotLinks: [],
    }
    const target = clusterIds[0]
    const now = utcNow()
    deleteClusterSuggestions(database, clusterIds)
    const move = database.prepare(
      "UPDATE faces SET cluster_id=?, revision=revision+1, updated_at=? WHERE cluster_id=?"
    )
    for (const source of clusterIds.slice(1)) {
      move.run(target, now, source)
      database.prepare("DELETE FROM clusters WHERE id=?").run(source)
    }
    database
      .prepare(
        "UPDATE clusters SET origin='manual', representative_face_id=?, "
          + "revision=revision+1, updated_at=? WHERE id=?"
      )
      .run(bestRepresentative(database, faceIds), now, target)
    recomputeCluster(database, target, now)
    return {
      payload: { clusterIds, target },
      inverse,
      result: getCluster(database, target),
    }
  })
}

function undoLastAction(database) {
  const action = database
    .prepare(
      "SELECT * FROM actions WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1"
    )
    .get()
  if (!action) return { undone: false }
  const inverse = JSON.parse(action.inverse_json)
  database.exec("BEGIN IMMEDIATE")
  try {
    database.exec("PRAGMA defer_foreign_keys = ON")
    restorePeople(database, inverse.people ?? [])
    restoreClusters(database, inverse.clusters ?? [])
    restoreFaces(database, inverse.faces ?? [])
    restoreClusterSuggestions(database, inverse.clusterSuggestions ?? [])
    for (const [faceA, faceB] of inverse.deleteCannotLinks ?? []) {
      database
        .prepare("DELETE FROM cannot_links WHERE face_id_a=? AND face_id_b=?")
        .run(faceA, faceB)
    }
    for (const clusterId of inverse.deleteClusters ?? []) {
      database.prepare("DELETE FROM clusters WHERE id=?").run(clusterId)
    }
    for (const personId of inverse.deletePeople ?? []) {
      database.prepare("DELETE FROM people WHERE id=?").run(personId)
    }
    database
      .prepare("UPDATE actions SET undone_at=? WHERE id=?")
      .run(utcNow(), action.id)
    database.exec("COMMIT")
    return { undone: true, actionType: action.action_type }
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

function mutate(database, body, actionType, operation) {
  const clientMutationId =
    typeof body.clientMutationId === "string" && body.clientMutationId
      ? validateMutationId(body.clientMutationId)
      : randomUUID()
  const prior = database
    .prepare("SELECT id FROM actions WHERE client_mutation_id=?")
    .get(clientMutationId)
  if (prior) return { replayed: true, actionId: number(prior.id) }
  database.exec("BEGIN IMMEDIATE")
  try {
    const outcome = operation()
    if (outcome.skipAction) {
      database.exec("COMMIT")
      return outcome.result
    }
    const action = database
      .prepare(
        "INSERT INTO actions "
          + "(client_mutation_id, action_type, payload_json, inverse_json, created_at) "
          + "VALUES (?,?,?,?,?)"
      )
      .run(
        clientMutationId,
        actionType,
        JSON.stringify(outcome.payload),
        JSON.stringify(outcome.inverse),
        utcNow()
      )
    database
      .prepare(
        "UPDATE workspace SET action_high_watermark=?, updated_at=? WHERE id=1"
      )
      .run(number(action.lastInsertRowid), utcNow())
    database.exec("COMMIT")
    return {
      actionId: number(action.lastInsertRowid),
      clientMutationId,
      ...outcome.result,
    }
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

function recomputeCluster(database, clusterId, now) {
  const rows = database
    .prepare(
      "SELECT id, status, person_id, quality_score FROM faces "
        + "WHERE cluster_id=? ORDER BY id"
    )
    .all(clusterId)
  if (!rows.length) {
    database.prepare("DELETE FROM clusters WHERE id=?").run(clusterId)
    return
  }
  const labelable = rows.filter(
    (face) => face.status !== "ignored" && face.status !== "unknown"
  )
  let status = "unreviewed"
  let personId = null
  if (!labelable.length) {
    status = rows.some((face) => face.status === "unknown")
      ? "unknown"
      : "ignored"
  } else {
    const labeled = labelable.filter(
      (face) => face.status === "labeled" && face.person_id
    )
    const personIds = new Set(labeled.map((face) => face.person_id))
    if (labeled.length === labelable.length && personIds.size === 1) {
      status = "labeled"
      personId = [...personIds][0]
    }
  }
  const representativePool = labelable.length
    ? labelable
    : rows.filter((face) => face.status === "unknown").length
      ? rows.filter((face) => face.status === "unknown")
      : rows
  const representative = [...representativePool].sort(
    (left, right) =>
      number(right.quality_score) - number(left.quality_score)
        || left.id.localeCompare(right.id)
  )[0].id
  database
    .prepare(
      "UPDATE clusters SET status=?, person_id=?, representative_face_id=?, "
        + "reviewed_at=?, revision=revision+1, updated_at=? WHERE id=?"
    )
    .run(
      status,
      personId,
      representative,
      status === "unreviewed" ? null : now,
      now,
      clusterId
    )
}

function hasCannotLinkAcrossClusters(database, clusterIds) {
  const placeholders = clusterIds.map(() => "?").join(",")
  const row = database
    .prepare(
      `SELECT 1
       FROM cannot_links cl
       JOIN faces a ON a.id=cl.face_id_a
       JOIN faces b ON b.id=cl.face_id_b
       WHERE a.cluster_id IN (${placeholders})
         AND b.cluster_id IN (${placeholders})
         AND a.cluster_id != b.cluster_id
       LIMIT 1`
    )
    .get(...clusterIds, ...clusterIds)
  return Boolean(row)
}

function bestRepresentative(database, faceIds) {
  if (!faceIds.length) return null
  const placeholders = faceIds.map(() => "?").join(",")
  return database
    .prepare(
      `SELECT id FROM faces WHERE id IN (${placeholders})
       ORDER BY
         CASE status WHEN 'ignored' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END,
         quality_score DESC, detection_score DESC, id
       LIMIT 1`
    )
    .get(...faceIds).id
}

function clusterSummarySql() {
  return `SELECT
    c.id, c.status, c.person_id, pe.display_name, c.representative_face_id,
    c.revision, c.reviewed_at, max(f.detection_score) AS confidence,
    count(f.id) AS face_count, count(DISTINCT f.photo_id) AS photo_count,
    min(ph.album_position) AS first_position
   FROM clusters c
   JOIN faces f ON f.cluster_id=c.id
   JOIN photos ph ON ph.id=f.photo_id
   LEFT JOIN people pe ON pe.id=c.person_id`
}

function serializeCluster(cluster) {
  return {
    id: cluster.id,
    status: cluster.status,
    personId: cluster.person_id,
    displayName: cluster.display_name,
    faceCount: number(cluster.face_count),
    photoCount: number(cluster.photo_count),
    representativeFaceId: cluster.representative_face_id,
    confidence: number(cluster.confidence),
    revision: number(cluster.revision),
    reviewedAt: cluster.reviewed_at,
    firstAlbumPosition: number(cluster.first_position),
  }
}

function facesForClusters(database, clusterIds) {
  if (!clusterIds.length) return []
  const placeholders = clusterIds.map(() => "?").join(",")
  return database
    .prepare(
      `SELECT id FROM faces WHERE cluster_id IN (${placeholders}) ORDER BY id`
    )
    .all(...clusterIds)
    .map((row) => row.id)
}

function snapshotFaces(database, faceIds) {
  return snapshotByIds(database, "faces", MUTABLE_FACE_COLUMNS, faceIds)
}

function snapshotClusters(database, clusterIds) {
  return snapshotByIds(
    database,
    "clusters",
    MUTABLE_CLUSTER_COLUMNS,
    clusterIds
  )
}

function snapshotClusterSuggestions(database, clusterIds) {
  if (!clusterIds.length) return []
  const placeholders = clusterIds.map(() => "?").join(",")
  return database
    .prepare(
      `SELECT ${CLUSTER_SUGGESTION_COLUMNS.join(",")}
       FROM cluster_suggestions
       WHERE cluster_id_a IN (${placeholders})
          OR cluster_id_b IN (${placeholders})
       ORDER BY cluster_id_a, cluster_id_b`
    )
    .all(...clusterIds, ...clusterIds)
}

function deleteClusterSuggestions(database, clusterIds) {
  if (!clusterIds.length) return
  const placeholders = clusterIds.map(() => "?").join(",")
  database
    .prepare(
      `DELETE FROM cluster_suggestions
       WHERE cluster_id_a IN (${placeholders})
          OR cluster_id_b IN (${placeholders})`
    )
    .run(...clusterIds, ...clusterIds)
}

function snapshotByIds(database, table, columns, ids) {
  if (!ids.length) return []
  const placeholders = ids.map(() => "?").join(",")
  return database
    .prepare(
      `SELECT ${columns.join(",")} FROM ${table} WHERE id IN (${placeholders}) ORDER BY id`
    )
    .all(...ids)
}

function restoreFaces(database, rows) {
  const statement = database.prepare(
    "UPDATE faces SET cluster_id=?, person_id=?, status=?, revision=?, "
      + "updated_at=? WHERE id=?"
  )
  for (const row of rows) {
    statement.run(
      row.cluster_id,
      row.person_id,
      row.status,
      row.revision,
      row.updated_at,
      row.id
    )
  }
}

function restoreClusters(database, rows) {
  restoreRows(database, "clusters", MUTABLE_CLUSTER_COLUMNS, rows)
}

function restorePeople(database, rows) {
  restoreRows(database, "people", PERSON_COLUMNS, rows)
}

function restoreClusterSuggestions(database, rows) {
  if (!rows.length) return
  const placeholders = CLUSTER_SUGGESTION_COLUMNS.map(() => "?").join(",")
  const statement = database.prepare(
    `INSERT INTO cluster_suggestions
       (${CLUSTER_SUGGESTION_COLUMNS.join(",")})
     VALUES (${placeholders})
     ON CONFLICT(cluster_id_a, cluster_id_b) DO UPDATE SET
       similarity_max=excluded.similarity_max,
       similarity_median=excluded.similarity_median,
       similarity_min=excluded.similarity_min,
       status=excluded.status,
       created_at=excluded.created_at`
  )
  for (const row of rows) {
    statement.run(
      ...CLUSTER_SUGGESTION_COLUMNS.map((column) => row[column])
    )
  }
}

function restoreRows(database, table, columns, rows) {
  if (!rows.length) return
  const placeholders = columns.map(() => "?").join(",")
  const updates = columns
    .filter((column) => column !== "id")
    .map((column) => `${column}=excluded.${column}`)
    .join(",")
  const statement = database.prepare(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updates}`
  )
  for (const row of rows) {
    statement.run(...columns.map((column) => row[column]))
  }
}

function requireCluster(database, clusterId) {
  const cluster = database.prepare("SELECT * FROM clusters WHERE id=?").get(clusterId)
  if (!cluster) throw notFound("Cluster")
  return cluster
}

function validateDisposition(state) {
  if (!["unreviewed", "unknown", "ignored"].includes(state)) {
    throw badRequest("Invalid disposition")
  }
  return state
}

function validateState(state) {
  if (!CLUSTER_STATES.has(state)) throw badRequest("Invalid cluster state")
  return state
}

function validateId(value, kind) {
  const patterns = {
    cluster: /^c_[a-zA-Z0-9_-]{8,80}$/,
    face: /^f_[a-f0-9]{32}$/,
    person: /^person_[a-f0-9]{32}$/,
    photo: /^p_[a-f0-9]{32}$/,
  }
  if (typeof value !== "string" || !patterns[kind].test(value)) {
    throw badRequest(`Invalid ${kind} ID`)
  }
  return value
}

function uniqueIds(value, kind) {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw badRequest(`Expected an array of ${kind} IDs`)
  }
  return [...new Set(value.map((item) => validateId(item, kind)))]
}

function requiredUniqueIds(value, kind) {
  if (!Array.isArray(value) || !value.length || value.length > 1_000) {
    throw badRequest(`Expected 1 to 1000 ${kind} IDs`)
  }
  const ids = value.map((item) => validateId(item, kind))
  if (new Set(ids).size !== ids.length) {
    throw badRequest(`${kind} IDs must be unique`)
  }
  return ids
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") throw badRequest("Name is required")
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ")
  const firstName = normalized.split(" ")[0]
  if (!firstName || firstName.length > 120) {
    throw badRequest("First name must be between 1 and 120 characters")
  }
  return FIRST_NAME_ALIASES.get(normalizeNameKey(firstName)) ?? firstName
}

function normalizeNameKey(value) {
  return value.toLocaleLowerCase("en-US")
}

function validateMutationId(value) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(value)) {
    throw badRequest("Invalid client mutation ID")
  }
  return value
}

function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
}

function utcNow() {
  return new Date().toISOString()
}

function number(value) {
  return Number(value ?? 0)
}

function httpError(status, message) {
  const error = new Error(message)
  error.statusCode = status
  return error
}

function badRequest(message) {
  return httpError(400, message)
}

function notFound(kind) {
  return httpError(404, `${kind} not found`)
}

function conflict(message) {
  return httpError(409, message)
}
