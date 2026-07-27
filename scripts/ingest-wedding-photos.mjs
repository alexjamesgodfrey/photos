#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const TOOL_VERSION = "1.0.0";
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const HELP = `
Create privacy-safe web derivatives from a Photos.app export.

Dry-run (the default):
  node scripts/ingest-wedding-photos.mjs \\
    --input "/path/to/Wedding Photos export"

Generate derivatives and manifests:
  node scripts/ingest-wedding-photos.mjs \\
    --input "/path/to/Wedding Photos export" \\
    --output "/Volumes/work/wedding-media" \\
    --album-id "wedding" \\
    --album-slug "wedding" \\
    --album-title "Wedding Photos" \\
    --apply

Options:
  --input PATH             Exported source directory (required)
  --output PATH            Work/output directory (required with --apply)
  --album-id ID            Stable database album id (default: wedding)
  --album-slug SLUG        Public album slug (default: wedding)
  --album-title TITLE      Album title (default: Wedding Photos)
  --prefix PREFIX          R2 object prefix (default: wedding)
  --thumb-size PX          Longest thumbnail edge (default: 640)
  --display-size PX        Longest display edge (default: 2560)
  --thumb-quality N        Encoder quality 1-100 (default: 76)
  --display-quality N      Encoder quality 1-100 (default: 84)
  --format FORMAT          webp, avif, or jpeg (default: webp)
  --concurrency N          Parallel source files (default: min(CPUs, 4))
  --limit N                Process only the first N files (testing)
  --force                  Rebuild even when a valid resume record exists
  --apply                  Write derivatives/manifests; otherwise dry-run
  --help                   Show this help

The script never modifies source files and never uploads anything.
`;

main().catch((error) => {
  console.error(`\nIngest failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP.trim());
    return;
  }

  validateOptions(options);

  const inputRoot = path.resolve(options.input);
  const inputInfo = await stat(inputRoot).catch(() => null);
  if (!inputInfo?.isDirectory()) {
    throw new Error(`--input must be a readable directory: ${inputRoot}`);
  }

  const outputRoot = options.output ? path.resolve(options.output) : null;
  if (outputRoot && isInside(inputRoot, outputRoot)) {
    throw new Error("--output cannot be inside --input (it would be scanned recursively)");
  }

  const files = await discoverImages(inputRoot, options.limit);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  console.log(
    `${options.apply ? "Ingest" : "Dry-run"}: ${files.length.toLocaleString()} images, ` +
      `${formatBytes(totalBytes)} of source data`,
  );

  if (!options.apply) {
    console.log(
      JSON.stringify(
        {
          input: inputRoot,
          output: outputRoot,
          image_count: files.length,
          source_bytes: totalBytes,
          settings: derivativeSettings(options),
          next_step: "Re-run with --output PATH --apply to generate files.",
        },
        null,
        2,
      ),
    );
    return;
  }

  const { sharp, exifr } = await loadImageDependencies();
  const settings = derivativeSettings(options, {
    sharp: sharp.versions?.sharp ?? "unknown",
    libvips: sharp.versions?.vips ?? "unknown",
  });
  const profileFingerprint = sha256Json(settings);
  const stateDirectory = path.join(outputRoot, ".state");
  const statePath = path.join(stateDirectory, "ingest.ndjson");
  const objectsRoot = path.join(outputRoot, "objects");
  const manifestRoot = path.join(outputRoot, "manifest");
  const tempRoot = path.join(outputRoot, ".tmp");

  await Promise.all([
    mkdir(stateDirectory, { recursive: true }),
    mkdir(objectsRoot, { recursive: true }),
    mkdir(manifestRoot, { recursive: true }),
    mkdir(tempRoot, { recursive: true }),
  ]);

  const completedBySignature = await loadCompletedState(statePath);
  const startedAt = new Date().toISOString();
  const buildBySourceHash = new Map();
  let appendQueue = Promise.resolve();
  let nextIndex = 0;
  let completed = 0;
  let resumed = 0;
  let failed = 0;
  const currentResults = new Map();

  const appendState = (entry) => {
    appendQueue = appendQueue.then(() =>
      appendFile(statePath, `${JSON.stringify(entry)}\n`, "utf8"),
    );
    return appendQueue;
  };

  const workers = Array.from(
    { length: Math.min(options.concurrency, Math.max(files.length, 1)) },
    async () => {
      while (true) {
        const fileIndex = nextIndex++;
        if (fileIndex >= files.length) return;
        const file = files[fileIndex];
        const signature = sourceSignature(file, profileFingerprint);

        try {
          const prior = completedBySignature.get(signature);
          if (
            !options.force &&
            prior &&
            (await recordObjectsExist(outputRoot, prior.record))
          ) {
            currentResults.set(signature, prior);
            resumed += 1;
            logProgress("resume", file.relativePath);
            continue;
          }

          const sourceHash = await hashFile(file.absolutePath);
          let buildPromise = buildBySourceHash.get(sourceHash);
          if (!buildPromise) {
            buildPromise = buildMediaAssets({
              file,
              sourceHash,
              outputRoot,
              tempRoot,
              options,
              sharp,
              exifr,
            });
            buildBySourceHash.set(sourceHash, buildPromise);
          }

          const assets = await buildPromise;
          const record = createPhotoRecord({
            assets,
            file,
            options,
          });
          const stateEntry = {
            type: "completed",
            version: 1,
            at: new Date().toISOString(),
            signature,
            source_relative_path: file.relativePath,
            record,
          };
          await appendState(stateEntry);
          completedBySignature.set(signature, stateEntry);
          currentResults.set(signature, stateEntry);
          completed += 1;
          logProgress("built", file.relativePath);
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          await appendState({
            type: "failed",
            version: 1,
            at: new Date().toISOString(),
            signature,
            source_relative_path: file.relativePath,
            error: message,
          });
          console.error(`failed: ${file.relativePath}: ${message}`);
        }
      }
    },
  );

  await Promise.all(workers);
  await appendQueue;

  const recordsByPhotoId = new Map();
  for (const entry of currentResults.values()) {
    const current = recordsByPhotoId.get(entry.record.id);
    if (
      !current ||
      entry.source_relative_path.localeCompare(current.source_relative_path) < 0
    ) {
      recordsByPhotoId.set(entry.record.id, entry);
    }
  }

  const photos = [...recordsByPhotoId.values()]
    .map((entry) => entry.record)
    .sort(comparePhotos)
    .map((record, albumPosition) => ({
      ...record,
      album_position: albumPosition,
    }));

  const runId = `run_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
  const photosNdjson = photos.map((photo) => JSON.stringify(photo)).join("\n") +
    (photos.length ? "\n" : "");
  const manifestHash = sha256Text(photosNdjson);
  const capturedTimes = photos
    .map((photo) => photo.captured_at)
    .filter(Boolean)
    .sort();
  const album = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    tool_version: TOOL_VERSION,
    album: {
      id: options.albumId,
      slug: options.albumSlug,
      title: options.albumTitle,
      description: null,
      default_sort: "captured_at_asc",
      photo_count: photos.length,
      captured_at_min: capturedTimes.at(0) ?? null,
      captured_at_max: capturedTimes.at(-1) ?? null,
    },
    import_run: {
      id: runId,
      album_id: options.albumId,
      status: failed ? "completed_with_errors" : "completed",
      tool_version: TOOL_VERSION,
      profile_fingerprint: profileFingerprint,
      manifest_sha256: manifestHash,
      discovered_count: files.length,
      imported_count: photos.length,
      skipped_count: resumed,
      failed_count: failed,
      complete_source_set: options.limit == null && failed === 0,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    },
    derivatives: settings,
  };

  const uploadPlan = photos.flatMap((photo) => [
    uploadPlanEntry(outputRoot, photo, "thumb"),
    uploadPlanEntry(outputRoot, photo, "display"),
  ]);
  const uploadNdjson =
    uploadPlan.map((entry) => JSON.stringify(entry)).join("\n") +
    (uploadPlan.length ? "\n" : "");

  await Promise.all([
    atomicWrite(
      path.join(manifestRoot, "album.json"),
      `${JSON.stringify(album, null, 2)}\n`,
    ),
    atomicWrite(path.join(manifestRoot, "photos.ndjson"), photosNdjson),
    atomicWrite(path.join(manifestRoot, "upload-plan.ndjson"), uploadNdjson),
  ]);

  console.log(
    [
      "",
      `Finished: ${photos.length.toLocaleString()} unique photos`,
      `  built:   ${completed.toLocaleString()}`,
      `  resumed: ${resumed.toLocaleString()}`,
      `  failed:  ${failed.toLocaleString()}`,
      `  manifest: ${path.join(manifestRoot, "photos.ndjson")}`,
      `  uploads:  ${path.join(manifestRoot, "upload-plan.ndjson")}`,
    ].join("\n"),
  );

  if (failed > 0) process.exitCode = 2;

  function logProgress(action, relativePath) {
    const processed = completed + resumed + failed;
    if (processed <= 10 || processed % 25 === 0 || processed === files.length) {
      console.log(
        `[${processed.toLocaleString()}/${files.length.toLocaleString()}] ${action}: ${relativePath}`,
      );
    }
  }
}

async function buildMediaAssets({
  file,
  sourceHash,
  outputRoot,
  tempRoot,
  options,
  sharp,
  exifr,
}) {
  const photoId = `p_${sourceHash.slice(0, 32)}`;
  const sourceMetadata = await sharp(file.absolutePath, {
    failOn: "warning",
    sequentialRead: true,
  }).metadata();
  if (!sourceMetadata.width || !sourceMetadata.height) {
    throw new Error("image dimensions are unavailable");
  }

  const safeExif = await readSafeExif(exifr, file.absolutePath);
  const display = await createDerivative({
    kind: "display",
    filePath: file.absolutePath,
    sourceHash,
    photoId,
    maxSize: options.displaySize,
    quality: options.displayQuality,
    format: options.format,
    prefix: options.prefix,
    outputRoot,
    tempRoot,
    sharp,
  });
  const thumb = await createDerivative({
    kind: "thumb",
    // Derive the thumbnail from the already auto-oriented, metadata-free
    // display asset. Large HEIC/TIFF sources are decoded only once.
    filePath: display.localPath,
    sourceHash,
    photoId,
    maxSize: options.thumbSize,
    quality: options.thumbQuality,
    format: options.format,
    prefix: options.prefix,
    outputRoot,
    tempRoot,
    sharp,
  });
  const visual = await createVisualHints(sharp, thumb.localPath);

  return {
    photoId,
    sourceHash,
    source_width: sourceMetadata.width,
    source_height: sourceMetadata.height,
    safeExif,
    thumb,
    display,
    visual,
  };
}

function createPhotoRecord({ assets, file, options }) {
  const captured = selectCapturedAt(assets.safeExif, file);
  return {
    id: assets.photoId,
    album_id: options.albumId,
    source_fingerprint: assets.sourceHash,
    original_filename: path.basename(file.absolutePath),
    source_bytes: file.size,
    source_width: assets.source_width,
    source_height: assets.source_height,
    captured_at: captured.value,
    captured_at_source: captured.source,
    media_type: "image",
    published: true,
    thumb_key: assets.thumb.objectKey,
    thumb_sha256: assets.thumb.sha256,
    thumb_width: assets.thumb.width,
    thumb_height: assets.thumb.height,
    thumb_bytes: assets.thumb.bytes,
    display_key: assets.display.objectKey,
    display_sha256: assets.display.sha256,
    width: assets.display.width,
    height: assets.display.height,
    display_bytes: assets.display.bytes,
    blur_data_url: assets.visual.blurDataUrl,
    dominant_color: assets.visual.dominantColor,
    metadata: {
      camera_make: assets.safeExif.Make ?? null,
      camera_model: assets.safeExif.Model ?? null,
      lens_model: assets.safeExif.LensModel ?? null,
      iso: finiteNumber(assets.safeExif.ISO),
      aperture: finiteNumber(assets.safeExif.FNumber),
      exposure_seconds: finiteNumber(assets.safeExif.ExposureTime),
      focal_length_mm: finiteNumber(assets.safeExif.FocalLength),
    },
  };
}

async function createDerivative({
  kind,
  filePath,
  sourceHash,
  photoId,
  maxSize,
  quality,
  format,
  prefix,
  outputRoot,
  tempRoot,
  sharp,
}) {
  const tempPath = path.join(
    tempRoot,
    `${photoId}-${kind}-${randomUUID()}.${format}`,
  );
  let pipeline = sharp(filePath, {
    failOn: "warning",
    sequentialRead: true,
  })
    .rotate()
    .resize({
      width: maxSize,
      height: maxSize,
      fit: "inside",
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    })
    .toColorspace("srgb");

  if (format === "webp") {
    pipeline = pipeline.webp({ quality, effort: 5, smartSubsample: true });
  } else if (format === "avif") {
    pipeline = pipeline.avif({ quality, effort: 5, chromaSubsampling: "4:2:0" });
  } else {
    pipeline = pipeline.jpeg({
      quality,
      mozjpeg: true,
      chromaSubsampling: "4:2:0",
    });
  }

  // Sharp strips source EXIF/XMP/IPTC by default. Do not add withMetadata() or
  // keepMetadata() here: location and other private source metadata must not
  // reach the uploaded object.
  const info = await pipeline.toFile(tempPath);
  const derivativeHash = await hashFile(tempPath);
  const objectKey = path.posix.join(
    prefix,
    sourceHash.slice(0, 2),
    photoId,
    `${kind}-${derivativeHash.slice(0, 20)}.${format}`,
  );
  const destination = localObjectPath(outputRoot, objectKey);
  await mkdir(path.dirname(destination), { recursive: true });

  if (await exists(destination)) {
    await unlink(tempPath);
  } else {
    await rename(tempPath, destination);
  }

  return {
    objectKey,
    localPath: destination,
    sha256: derivativeHash,
    width: info.width,
    height: info.height,
    bytes: info.size,
  };
}

async function createVisualHints(sharp, filePath) {
  const blur = await sharp(filePath, { failOn: "warning", sequentialRead: true })
    .rotate()
    .resize({ width: 32, height: 32, fit: "inside", withoutEnlargement: true })
    .toColorspace("srgb")
    .jpeg({ quality: 35, mozjpeg: true })
    .toBuffer();
  const pixel = await sharp(filePath, { failOn: "warning", sequentialRead: true })
    .rotate()
    .resize({ width: 1, height: 1, fit: "fill" })
    .removeAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer();
  const [red = 127, green = 127, blue = 127] = pixel;
  return {
    blurDataUrl: `data:image/jpeg;base64,${blur.toString("base64")}`,
    dominantColor: `#${[red, green, blue]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`,
  };
}

async function readSafeExif(exifr, filePath) {
  try {
    return (
      (await exifr.parse(filePath, {
        pick: [
          "DateTimeOriginal",
          "CreateDate",
          "Make",
          "Model",
          "LensModel",
          "ISO",
          "FNumber",
          "ExposureTime",
          "FocalLength",
        ],
      })) ?? {}
    );
  } catch {
    return {};
  }
}

function selectCapturedAt(exif, file) {
  for (const candidate of [exif.DateTimeOriginal, exif.CreateDate]) {
    const parsed = dateToIso(candidate);
    if (parsed) return { value: parsed, source: "exif" };
  }
  // Photos exports are more likely to preserve capture time as mtime; birthtime
  // commonly reflects when the export copy itself was created.
  const fallback = file.mtimeMs > 0 ? file.mtimeMs : file.birthtimeMs;
  const parsed = dateToIso(fallback);
  return parsed
    ? { value: parsed, source: "filesystem" }
    : { value: null, source: "unknown" };
}

function comparePhotos(left, right) {
  if (left.captured_at && right.captured_at) {
    const byDate = left.captured_at.localeCompare(right.captured_at);
    if (byDate !== 0) return byDate;
  } else if (left.captured_at) {
    return -1;
  } else if (right.captured_at) {
    return 1;
  }
  const byName = left.original_filename.localeCompare(right.original_filename, "en", {
    numeric: true,
    sensitivity: "base",
  });
  return byName || left.id.localeCompare(right.id);
}

function uploadPlanEntry(outputRoot, photo, kind) {
  const objectKey = photo[`${kind}_key`];
  return {
    photo_id: photo.id,
    kind,
    object_key: objectKey,
    local_path: localObjectPath(outputRoot, objectKey),
    content_type: contentTypeForKey(objectKey),
    cache_control: CACHE_CONTROL,
    sha256: photo[`${kind}_sha256`],
    bytes: photo[`${kind}_bytes`],
  };
}

async function discoverImages(root, limit) {
  const files = [];

  async function visit(directory) {
    const iterator = await opendir(directory);
    for await (const entry of iterator) {
      if (limit && files.length >= limit) return;
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (
        entry.isFile() &&
        IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        const info = await stat(absolutePath);
        files.push({
          absolutePath,
          relativePath: path.relative(root, absolutePath),
          size: info.size,
          mtimeMs: info.mtimeMs,
          birthtimeMs: info.birthtimeMs,
        });
      }
    }
  }

  await visit(root);
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en", {
      numeric: true,
      sensitivity: "base",
    }),
  );
  return limit ? files.slice(0, limit) : files;
}

async function loadCompletedState(statePath) {
  const result = new Map();
  const body = await readFile(statePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "completed" && entry.signature && entry.record) {
        result.set(entry.signature, entry);
      }
    } catch {
      // A terminated append can leave one partial final line. It is safe to
      // ignore because a successful derivative remains content-addressed and
      // the source will simply be processed once more.
    }
  }
  return result;
}

async function recordObjectsExist(outputRoot, record) {
  try {
    const [thumb, display] = await Promise.all([
      stat(localObjectPath(outputRoot, record.thumb_key)).catch(() => null),
      stat(localObjectPath(outputRoot, record.display_key)).catch(() => null),
    ]);
    return (
      thumb?.isFile() &&
      display?.isFile() &&
      thumb.size === record.thumb_bytes &&
      display.size === record.display_bytes
    );
  } catch {
    return false;
  }
}

function localObjectPath(outputRoot, objectKey) {
  if (
    !objectKey ||
    path.posix.isAbsolute(objectKey) ||
    objectKey.split("/").includes("..")
  ) {
    throw new Error(`unsafe object key: ${objectKey}`);
  }
  return path.join(outputRoot, "objects", ...objectKey.split("/"));
}

async function atomicWrite(destination, content) {
  await mkdir(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, destination);
}

async function loadImageDependencies() {
  try {
    const [sharpModule, exifrModule] = await Promise.all([
      import("sharp"),
      import("exifr"),
    ]);
    return {
      sharp: sharpModule.default,
      exifr: exifrModule.default ?? exifrModule,
    };
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw new Error(
      "Missing image tooling. Install locally without changing package files:\n" +
        "  npm install --no-save --package-lock=false sharp exifr",
    );
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function sourceSignature(file, profileFingerprint) {
  return sha256Text(
    [
      file.relativePath.normalize("NFC"),
      file.size,
      Math.trunc(file.mtimeMs),
      profileFingerprint,
    ].join("\0"),
  );
}

function derivativeSettings(options, encoder = {}) {
  return {
    profile_version: 1,
    tool_version: TOOL_VERSION,
    encoder: {
      sharp: encoder.sharp ?? "not-loaded",
      libvips: encoder.libvips ?? "not-loaded",
    },
    album_id: options.albumId,
    prefix: options.prefix,
    thumb: {
      max_edge: options.thumbSize,
      format: options.format,
      quality: options.thumbQuality,
    },
    display: {
      max_edge: options.displaySize,
      format: options.format,
      quality: options.displayQuality,
    },
    auto_orient: true,
    colorspace: "srgb",
    source_metadata_preserved: false,
    cache_control: CACHE_CONTROL,
  };
}

function parseArguments(args) {
  const options = {
    apply: false,
    force: false,
    help: false,
    input: null,
    output: null,
    albumId: "wedding",
    albumSlug: "wedding",
    albumTitle: "Wedding Photos",
    prefix: "wedding",
    thumbSize: 640,
    displaySize: 2560,
    thumbQuality: 76,
    displayQuality: 84,
    format: "webp",
    concurrency: Math.max(1, Math.min(os.availableParallelism?.() ?? os.cpus().length, 4)),
    limit: null,
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
      case "--force":
        options.force = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--input":
        options.input = valueFor(index, argument);
        index += 1;
        break;
      case "--output":
        options.output = valueFor(index, argument);
        index += 1;
        break;
      case "--album-id":
        options.albumId = valueFor(index, argument);
        index += 1;
        break;
      case "--album-slug":
        options.albumSlug = valueFor(index, argument);
        index += 1;
        break;
      case "--album-title":
        options.albumTitle = valueFor(index, argument);
        index += 1;
        break;
      case "--prefix":
        options.prefix = valueFor(index, argument);
        index += 1;
        break;
      case "--thumb-size":
        options.thumbSize = numberArgument(valueFor(index, argument), argument);
        index += 1;
        break;
      case "--display-size":
        options.displaySize = numberArgument(valueFor(index, argument), argument);
        index += 1;
        break;
      case "--thumb-quality":
        options.thumbQuality = numberArgument(valueFor(index, argument), argument);
        index += 1;
        break;
      case "--display-quality":
        options.displayQuality = numberArgument(valueFor(index, argument), argument);
        index += 1;
        break;
      case "--format":
        options.format = valueFor(index, argument).toLowerCase();
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = numberArgument(valueFor(index, argument), argument);
        index += 1;
        break;
      case "--limit":
        options.limit = numberArgument(valueFor(index, argument), argument);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}\n\n${HELP.trim()}`);
    }
  }
  return options;
}

function validateOptions(options) {
  if (!options.input) throw new Error("--input is required");
  if (options.apply && !options.output) {
    throw new Error("--output is required with --apply");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.albumId)) {
    throw new Error("--album-id must be 1-128 safe identifier characters");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(options.albumSlug)) {
    throw new Error("--album-slug must be a lowercase URL slug");
  }
  options.prefix = options.prefix.replace(/^\/+|\/+$/g, "");
  if (
    !options.prefix ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.prefix) ||
    options.prefix.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("--prefix must be a safe relative object prefix");
  }
  if (!["webp", "avif", "jpeg"].includes(options.format)) {
    throw new Error("--format must be webp, avif, or jpeg");
  }
  for (const [label, value] of [
    ["--thumb-size", options.thumbSize],
    ["--display-size", options.displaySize],
  ]) {
    if (value < 32 || value > 16384) {
      throw new Error(`${label} must be between 32 and 16384`);
    }
  }
  for (const [label, value] of [
    ["--thumb-quality", options.thumbQuality],
    ["--display-quality", options.displayQuality],
  ]) {
    if (value < 1 || value > 100) {
      throw new Error(`${label} must be between 1 and 100`);
    }
  }
  if (options.concurrency < 1 || options.concurrency > 32) {
    throw new Error("--concurrency must be between 1 and 32");
  }
}

function numberArgument(raw, label) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function dateToIso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function contentTypeForKey(key) {
  if (key.endsWith(".avif")) return "image/avif";
  if (key.endsWith(".jpeg") || key.endsWith(".jpg")) return "image/jpeg";
  return "image/webp";
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
