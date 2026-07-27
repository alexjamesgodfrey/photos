#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const PHOTO_COLUMNS = [
  "id",
  "album_id",
  "imported_run_id",
  "source_fingerprint",
  "original_filename",
  "source_bytes",
  "source_width",
  "source_height",
  "captured_at",
  "captured_at_source",
  "album_position",
  "media_type",
  "published",
  "thumb_key",
  "thumb_sha256",
  "thumb_width",
  "thumb_height",
  "thumb_bytes",
  "display_key",
  "display_sha256",
  "width",
  "height",
  "display_bytes",
  "blur_data_url",
  "dominant_color",
  "metadata",
];

const HELP = `
Generate idempotent PostgreSQL import batches from an ingest manifest.
This script writes SQL files only; it never connects to a database.

Dry-run:
  node scripts/generate-db-import.mjs \\
    --manifest-dir "/Volumes/work/wedding-media/manifest"

Write SQL batches:
  node scripts/generate-db-import.mjs \\
    --manifest-dir "/Volumes/work/wedding-media/manifest" \\
    --output "/Volumes/work/wedding-media/db-import" \\
    --apply

Options:
  --manifest-dir PATH      Directory containing album.json and photos.ndjson
  --output PATH            Parent for run-specific SQL directory (with --apply)
  --batch-size N           Photos per transaction (default: 250)
  --authoritative          Unpublish album rows absent from this manifest
  --apply                  Write SQL files; otherwise dry-run
  --help                   Show this help

--authoritative is rejected unless the manifest proves a complete, error-free,
non-limited ingest.
`;

main().catch((error) => {
  console.error(`\nImport generation failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP.trim());
    return;
  }
  if (!options.manifestDir) throw new Error("--manifest-dir is required");
  if (options.apply && !options.output) {
    throw new Error("--output is required with --apply");
  }

  const manifestDirectory = path.resolve(options.manifestDir);
  const albumPath = path.join(manifestDirectory, "album.json");
  const photosPath = path.join(manifestDirectory, "photos.ndjson");
  const [albumBody, photosBody] = await Promise.all([
    readFile(albumPath, "utf8"),
    readFile(photosPath, "utf8"),
  ]);
  const manifest = JSON.parse(albumBody);
  const photos = parseNdjson(photosBody, photosPath);
  validateManifest(manifest, photos, photosBody);
  if (
    options.authoritative &&
    (manifest.import_run.complete_source_set !== true ||
      manifest.import_run.status !== "completed" ||
      manifest.import_run.failed_count !== 0)
  ) {
    throw new Error(
      "--authoritative requires a complete, successful, non-limited ingest manifest",
    );
  }

  const batchCount = Math.ceil(photos.length / options.batchSize);
  console.log(
    `${options.apply ? "Write" : "Dry-run"}: ${photos.length.toLocaleString()} photos, ` +
      `${batchCount.toLocaleString()} SQL batches`,
  );
  console.log(`Album: ${manifest.album.id} (${manifest.album.slug})`);
  console.log(`Import run: ${manifest.import_run.id}`);
  console.log(`Authoritative sync: ${options.authoritative ? "yes" : "no"}`);
  if (!options.apply) {
    console.log("Re-run with --output PATH --apply to write SQL.");
    return;
  }

  const outputDirectory = path.join(
    path.resolve(options.output),
    [
      "import",
      manifest.import_run.id,
      manifest.import_run.manifest_sha256.slice(0, 12),
      `b${options.batchSize}`,
    ].join("-"),
  );
  await mkdir(outputDirectory, { recursive: true });
  const written = [];

  const setupPath = path.join(outputDirectory, "000-album-and-run.sql");
  await atomicWrite(setupPath, setupSql(manifest));
  written.push(setupPath);

  for (let offset = 0; offset < photos.length; offset += options.batchSize) {
    const batchNumber = Math.floor(offset / options.batchSize) + 1;
    const batch = photos.slice(offset, offset + options.batchSize);
    const destination = path.join(
      outputDirectory,
      `photos-${String(batchNumber).padStart(5, "0")}.sql`,
    );
    await atomicWrite(
      destination,
      photoBatchSql(batch, manifest.import_run.id),
    );
    written.push(destination);
  }

  const finalizePath = path.join(outputDirectory, "999-finalize-run.sql");
  await atomicWrite(
    finalizePath,
    finalizeSql(manifest, photos.length, options.authoritative),
  );
  written.push(finalizePath);

  const instructions = [
    "# Generated PlanetScale import",
    "",
    "Apply the schema migration first, then run these files in the exact order below.",
    "Each file is transactional and safe to re-run.",
    "",
    "```bash",
    "set -e",
    "for base in \\",
    ...written.map(
      (file, index) =>
        `  ${path.basename(file)}${index === written.length - 1 ? "" : " \\"}`,
    ),
    "do",
    '  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$IMPORT_DIR/$base"',
    "done",
    "```",
    "",
    `Manifest SHA-256: \`${manifest.import_run.manifest_sha256}\``,
    `Authoritative sync: \`${options.authoritative}\``,
    "",
  ].join("\n");
  const instructionsPath = path.join(outputDirectory, "README.md");
  await atomicWrite(instructionsPath, instructions);
  written.push(instructionsPath);

  console.log(`Wrote ${written.length.toLocaleString()} files to ${outputDirectory}`);
}

function setupSql(manifest) {
  const { album, import_run: run } = manifest;
  return [
    "-- Generated by scripts/generate-db-import.mjs",
    "-- Apply database/001_wedding_photos.sql first.",
    "BEGIN;",
    "",
    `INSERT INTO wedding_photos.albums (`,
    "  id, slug, title, description, default_sort, photo_count,",
    "  captured_at_min, captured_at_max, updated_at",
    ") VALUES (",
    `  ${sql(album.id)}, ${sql(album.slug)}, ${sql(album.title)}, ${sql(
      album.description,
    )}, ${sql(album.default_sort)}, 0,`,
    "  NULL, NULL, now()",
    ")",
    "ON CONFLICT (id) DO UPDATE SET",
    "  slug = EXCLUDED.slug,",
    "  title = EXCLUDED.title,",
    "  description = EXCLUDED.description,",
    "  default_sort = EXCLUDED.default_sort,",
    "  updated_at = now();",
    "",
    "INSERT INTO wedding_photos.import_runs (",
    "  id, album_id, status, tool_version, profile_fingerprint,",
    "  manifest_sha256, discovered_count, imported_count, skipped_count,",
    "  failed_count, complete_source_set, started_at, completed_at, updated_at",
    ") VALUES (",
    `  ${sql(run.id)}, ${sql(run.album_id)}, 'running', ${sql(
      run.tool_version,
    )}, ${sql(run.profile_fingerprint)},`,
    `  ${sql(run.manifest_sha256)}, ${sql(run.discovered_count)}, 0, ${sql(
      run.skipped_count,
    )},`,
    `  ${sql(run.failed_count)}, ${sql(run.complete_source_set)}, ${sql(
      run.started_at,
    )}, NULL, now()`,
    ")",
    "ON CONFLICT (id) DO UPDATE SET",
    "  status = 'running',",
    "  tool_version = EXCLUDED.tool_version,",
    "  profile_fingerprint = EXCLUDED.profile_fingerprint,",
    "  manifest_sha256 = EXCLUDED.manifest_sha256,",
    "  discovered_count = EXCLUDED.discovered_count,",
    "  imported_count = 0,",
    "  skipped_count = EXCLUDED.skipped_count,",
    "  failed_count = EXCLUDED.failed_count,",
    "  complete_source_set = EXCLUDED.complete_source_set,",
    "  started_at = EXCLUDED.started_at,",
    "  completed_at = NULL,",
    "  updated_at = now();",
    "",
    "COMMIT;",
    "",
  ].join("\n");
}

function photoBatchSql(photos, importRunId) {
  const rows = photos.map((photo) => {
    const row = {
      ...photo,
      imported_run_id: importRunId,
      published: false,
    };
    return `  (${PHOTO_COLUMNS.map((column) =>
      column === "metadata" ? `${sqlJson(row[column])}::jsonb` : sql(row[column]),
    ).join(", ")})`;
  });

  const mutableColumns = PHOTO_COLUMNS.filter(
    (column) => !["id", "published"].includes(column),
  );
  return [
    "-- Generated by scripts/generate-db-import.mjs",
    "BEGIN;",
    "",
    "-- Serialize batch writes and final publication for this album.",
    "SELECT album.id",
    "FROM wedding_photos.albums AS album",
    "JOIN wedding_photos.import_runs AS import_run",
    "  ON import_run.album_id = album.id",
    `WHERE import_run.id = ${sql(importRunId)}`,
    "FOR UPDATE OF album;",
    "",
    `INSERT INTO wedding_photos.photos (${PHOTO_COLUMNS.join(", ")})`,
    "VALUES",
    rows.join(",\n"),
    "ON CONFLICT (id) DO UPDATE SET",
    mutableColumns
      .map((column) => `  ${column} = EXCLUDED.${column}`)
      .concat("  updated_at = now()")
      .join(",\n") + ";",
    "",
    "COMMIT;",
    "",
  ].join("\n");
}

function finalizeSql(manifest, importedCount, authoritative) {
  const { album, import_run: run } = manifest;
  const statements = [
    "-- Generated by scripts/generate-db-import.mjs",
    "BEGIN;",
    "",
    "-- Serialize final publication with every generated batch for this album.",
    "SELECT album.id",
    "FROM wedding_photos.albums AS album",
    "JOIN wedding_photos.import_runs AS import_run",
    "  ON import_run.album_id = album.id",
    `WHERE album.id = ${sql(album.id)}`,
    `  AND import_run.id = ${sql(run.id)}`,
    "FOR UPDATE OF album;",
    "",
    "-- Abort the transaction rather than publish a partial set if any generated",
    "-- batch was skipped or overwritten by a concurrent import.",
    "DO $import_guard$",
    "DECLARE",
    "  staged_count bigint;",
    "BEGIN",
    "  IF NOT EXISTS (",
    "    SELECT 1",
    "    FROM wedding_photos.import_runs",
    `    WHERE id = ${sql(run.id)} AND album_id = ${sql(album.id)}`,
    "  ) THEN",
    "    RAISE EXCEPTION 'Import run % is missing for album %',",
    `      ${sql(run.id)}, ${sql(album.id)};`,
    "  END IF;",
    "",
    "  SELECT count(*) INTO staged_count",
    "  FROM wedding_photos.photos",
    `  WHERE album_id = ${sql(album.id)}`,
    `    AND imported_run_id = ${sql(run.id)};`,
    "",
    `  IF staged_count <> ${sql(importedCount)} THEN`,
    "    RAISE EXCEPTION 'Import run % staged % photos; expected %',",
    `      ${sql(run.id)}, staged_count, ${sql(importedCount)};`,
    "  END IF;",
    "END",
    "$import_guard$;",
    "",
    "-- New rows were staged unpublished. Existing rows retained their previous",
    "-- visibility while their metadata was refreshed.",
    "UPDATE wedding_photos.photos",
    "SET published = true, updated_at = now()",
    `WHERE album_id = ${sql(album.id)}`,
    `  AND imported_run_id = ${sql(run.id)}`,
    "  AND published = false;",
    "",
  ];

  if (authoritative) {
    statements.push(
      "-- This manifest is the complete album: hide rows it did not contain.",
      "UPDATE wedding_photos.photos",
      "SET published = false, updated_at = now()",
      `WHERE album_id = ${sql(album.id)}`,
      `  AND imported_run_id IS DISTINCT FROM ${sql(run.id)}`,
      "  AND published = true;",
      "",
    );
  }

  statements.push(
    "-- Recompute aggregates from all currently published rows. This remains",
    "-- correct for both additive and authoritative imports.",
    "UPDATE wedding_photos.albums AS album",
    "SET photo_count = totals.photo_count,",
    "    captured_at_min = totals.captured_at_min,",
    "    captured_at_max = totals.captured_at_max,",
    "    updated_at = now()",
    "FROM (",
    "  SELECT",
    "    count(*)::bigint AS photo_count,",
    "    min(captured_at) AS captured_at_min,",
    "    max(captured_at) AS captured_at_max",
    "  FROM wedding_photos.photos",
    `  WHERE album_id = ${sql(album.id)} AND published = true`,
    ") AS totals",
    `WHERE album.id = ${sql(album.id)};`,
    "",
    "UPDATE wedding_photos.import_runs",
    `SET status = ${sql(run.status)},`,
    `    imported_count = ${sql(importedCount)},`,
    `    failed_count = ${sql(run.failed_count)},`,
    `    completed_at = ${sql(run.completed_at)},`,
    "    updated_at = now()",
    `WHERE id = ${sql(run.id)};`,
    "",
    "COMMIT;",
    "",
  );
  return statements.join("\n");
}

function validateManifest(manifest, photos, photosBody) {
  if (manifest?.schema_version !== 1) {
    throw new Error("unsupported or missing album manifest schema_version");
  }
  if (!manifest.album?.id || !manifest.album?.slug || !manifest.import_run?.id) {
    throw new Error("album.json is missing album/import run identifiers");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.album.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.import_run.id)
  ) {
    throw new Error("album/import run identifiers contain unsafe characters");
  }
  if (typeof manifest.import_run.complete_source_set !== "boolean") {
    throw new Error("album.json is missing import_run.complete_source_set");
  }
  const actualHash = createHash("sha256").update(photosBody).digest("hex");
  if (actualHash !== manifest.import_run.manifest_sha256) {
    throw new Error(
      `photos.ndjson hash mismatch: expected ${manifest.import_run.manifest_sha256}, found ${actualHash}`,
    );
  }
  if (manifest.album.photo_count !== photos.length) {
    throw new Error(
      `photo count mismatch: album.json says ${manifest.album.photo_count}, found ${photos.length}`,
    );
  }

  const ids = new Set();
  const positions = new Set();
  for (const [index, photo] of photos.entries()) {
    for (const column of PHOTO_COLUMNS.filter(
      (name) => !["imported_run_id"].includes(name),
    )) {
      if (!(column in photo)) {
        throw new Error(`photos.ndjson line ${index + 1} is missing ${column}`);
      }
    }
    if (photo.album_id !== manifest.album.id) {
      throw new Error(`photos.ndjson line ${index + 1} has the wrong album_id`);
    }
    if (ids.has(photo.id)) {
      throw new Error(`duplicate photo id: ${photo.id}`);
    }
    if (positions.has(photo.album_position)) {
      throw new Error(`duplicate album_position: ${photo.album_position}`);
    }
    ids.add(photo.id);
    positions.add(photo.album_position);
  }
}

function parseNdjson(body, filePath) {
  const rows = [];
  for (const [index, line] of body.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid NDJSON at ${filePath}:${index + 1}`);
    }
  }
  return rows;
}

function sql(value) {
  if (value == null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot encode non-finite SQL number");
    return String(value);
  }
  const text = String(value);
  if (text.includes("\0")) throw new Error("cannot encode a NUL byte in SQL");
  return `'${text.replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return sql(JSON.stringify(value ?? {}));
}

async function atomicWrite(destination, content) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
}

function parseArguments(args) {
  const options = {
    apply: false,
    authoritative: false,
    help: false,
    manifestDir: null,
    output: null,
    batchSize: 250,
  };
  const valueFor = (index, name) => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--apply":
        options.apply = true;
        break;
      case "--authoritative":
        options.authoritative = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--manifest-dir":
        options.manifestDir = valueFor(index, argument);
        index += 1;
        break;
      case "--output":
        options.output = valueFor(index, argument);
        index += 1;
        break;
      case "--batch-size":
        options.batchSize = positiveInteger(valueFor(index, argument), argument);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}\n\n${HELP.trim()}`);
    }
  }
  if (options.batchSize > 5_000) {
    throw new Error("--batch-size cannot exceed 5000");
  }
  return options;
}

function positiveInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
