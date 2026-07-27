#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const PRIVATE_MEDIA_ROOT = path.join(REPO_ROOT, ".media-staging");
const PRODUCTION_BUCKET = "alex-sierra-wedding-photos";
const PRODUCTION_PREFIX = "wedding/";
const PRODUCTION_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PERSON_ID_PATTERN = /^person_[a-f0-9]{32}$/;
const WRANGLER_TARGET_OVERRIDE_VARIABLES = [
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_EMAIL",
  "CLOUDFLARE_API_BASE_URL",
  "CF_API_BASE_URL",
  "WRANGLER_API_ENVIRONMENT",
];

const HELP = `
Upload a verified photo-derivative or face-avatar plan to Cloudflare R2 using an
already-authenticated Wrangler CLI. Dry-run is the default.

Dry-run:
  node scripts/upload-r2.mjs \\
    --manifest "/Volumes/work/wedding-media/manifest/upload-plan.ndjson" \\
    --profile wedding-production \\
    --account-id 0123456789abcdef0123456789abcdef

Upload:
  node scripts/upload-r2.mjs \\
    --manifest "/Volumes/work/wedding-media/manifest/upload-plan.ndjson" \\
    --profile wedding-production \\
    --account-id 0123456789abcdef0123456789abcdef \\
    --apply

Options:
  --manifest PATH          Photo or private avatar upload-plan.ndjson (required)
  --profile NAME           Existing named Wrangler auth profile (required)
  --account-id ID          Exact 32-character Cloudflare account id (required)
  --concurrency N          Parallel Wrangler processes (default: 4)
  --wrangler PATH          Wrangler executable (default: wrangler)
  --ledger PATH            Resume ledger (default: next to media work state)
  --max-attempts N         Attempts per object (default: 3)
  --force                  Upload objects already present in the local ledger
  --apply                  Perform remote PUTs; otherwise dry-run
  --help                   Show this help

This script never creates credentials. Authenticate Wrangler separately with the
intended Cloudflare account before using --apply. The only permitted destination
bucket is ${PRODUCTION_BUCKET}.
`;

main().catch((error) => {
  console.error(`\nR2 upload failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP.trim());
    return;
  }
  validateOptions(options);

  const manifestPath = path.resolve(options.manifest);
  const entries = await readNdjson(manifestPath);
  validateEntries(entries);
  await validateAvatarSources(entries);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const target = {
    accountId: options.accountId,
    profile: options.profile,
    bucket: PRODUCTION_BUCKET,
    bucketCreatedAt: null,
  };
  const identityScope = sha256Text(
    JSON.stringify({
      account_id: target.accountId,
      profile: target.profile,
      bucket: target.bucket,
    }),
  ).slice(0, 16);
  const ledgerBasePath = options.ledger
    ? path.resolve(options.ledger)
    : path.resolve(
        path.dirname(manifestPath),
        "..",
        ".state",
        `r2-${PRODUCTION_BUCKET}-${identityScope}`,
      );

  if (!options.apply) {
    printTargetSummary({
      action: "Dry-run",
      entries,
      pending: entries,
      totalBytes,
      target,
      ledgerPath: options.ledger
        ? ledgerBasePath
        : `${ledgerBasePath}-<verified-bucket-incarnation>.ndjson`,
    });
    for (const entry of entries.slice(0, 5)) {
      console.log(`  would put: ${entry.object_key} (${formatBytes(entry.bytes)})`);
    }
    if (entries.length > 5) {
      console.log(`  …and ${(entries.length - 5).toLocaleString()} more`);
    }
    console.log(
      "Offline dry-run does not trust a resume ledger; --apply verifies the remote bucket and every would-be skip.",
    );
    return;
  }

  assertProfileAuthenticationIsUnshadowed();
  if (options.wrangler.includes(path.sep)) {
    options.wrangler = path.resolve(options.wrangler);
  }
  // Run remote commands outside every project tree. A nearby wrangler config
  // or .env must not override the audited account id or named profile.
  options.wranglerCwd = await mkdtemp(
    path.join(os.tmpdir(), "wedding-r2-wrangler-"),
  );
  let releaseLock;
  try {
    releaseLock = await acquireUploadLock(target);
    await assertExecutable(options.wrangler);
    const bucket = await preflightRemoteTarget(options);
    target.bucketCreatedAt = bucket.created;
    const ledgerPath = options.ledger
      ? ledgerBasePath
      : `${ledgerBasePath}-${sha256Text(target.bucketCreatedAt).slice(0, 12)}.ndjson`;
    const pending = await pendingEntries({
      entries,
      ledgerPath,
      target,
      force: options.force,
      options,
    });
    printTargetSummary({
      action: "Upload",
      entries,
      pending,
      totalBytes,
      target,
      ledgerPath,
    });
    await uploadPending({
      entries: pending,
      ledgerPath,
      options,
      target,
    });
  } finally {
    try {
      if (releaseLock) await releaseLock();
    } finally {
      await rm(options.wranglerCwd, { recursive: true, force: true });
    }
  }
}

async function pendingEntries({
  entries,
  ledgerPath,
  target,
  force,
  options,
}) {
  if (force) return entries;
  const uploaded = await loadLedger(ledgerPath, target);
  const ledgerCandidates = entries.filter(
    (entry) => uploaded.get(entry.object_key) === uploadFingerprint(entry),
  );
  if (ledgerCandidates.length === 0) return entries;

  console.log(
    `Verifying ${ledgerCandidates.length.toLocaleString()} ledger-backed objects against remote R2 content...`,
  );
  const remotelyVerified = new Set();
  let cursor = 0;
  const workers = Array.from(
    {
      length: Math.min(
        options.concurrency,
        Math.max(ledgerCandidates.length, 1),
      ),
    },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= ledgerCandidates.length) return;
        const entry = ledgerCandidates[index];
        if (await remoteObjectMatches(entry, options)) {
          remotelyVerified.add(entry.object_key);
        }
      }
    },
  );
  await Promise.all(workers);
  return entries.filter((entry) => !remotelyVerified.has(entry.object_key));
}

function printTargetSummary({
  action,
  entries,
  pending,
  totalBytes,
  target,
  ledgerPath,
}) {
  console.log(
    `${action}: ${entries.length.toLocaleString()} objects ` +
      `(${formatBytes(totalBytes)}), ${pending.length.toLocaleString()} pending`,
  );
  console.log(`Account: ${target.accountId}`);
  console.log(`Profile: ${target.profile}`);
  console.log(`Bucket: ${target.bucket}`);
  if (target.bucketCreatedAt) {
    console.log(`Bucket created: ${target.bucketCreatedAt}`);
  }
  console.log(`Resume ledger: ${ledgerPath}`);
}

async function uploadPending({ entries, ledgerPath, options, target }) {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const stagingDirectory = path.join(options.wranglerCwd, "verified-uploads");
  await mkdir(stagingDirectory, { recursive: true });
  let cursor = 0;
  let succeeded = 0;
  let failed = 0;
  let appendQueue = Promise.resolve();
  const appendLedger = (entry) => {
    appendQueue = appendQueue.then(() =>
      appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8"),
    );
    return appendQueue;
  };

  const workers = Array.from(
    { length: Math.min(options.concurrency, Math.max(entries.length, 1)) },
    async () => {
      while (true) {
        const currentIndex = cursor++;
        if (currentIndex >= entries.length) return;
        const entry = entries[currentIndex];
        let stagedPath;
        try {
          stagedPath = await stageVerifiedObject(entry, stagingDirectory);
          await putWithRetry(entry, stagedPath, options);
          succeeded += 1;
          await appendLedger({
            type: "uploaded",
            version: 1,
            at: new Date().toISOString(),
            account_id: target.accountId,
            profile: target.profile,
            bucket: target.bucket,
            bucket_created_at: target.bucketCreatedAt,
            object_key: entry.object_key,
            sha256: entry.sha256,
            content_type: entry.content_type,
            cache_control: entry.cache_control,
            upload_fingerprint: uploadFingerprint(entry),
            bytes: entry.bytes,
          });
          logProgress("uploaded", entry.object_key);
        } catch (error) {
          failed += 1;
          console.error(
            `failed: ${entry.object_key}: ${
              error instanceof Error ? error.message : error
            }`,
          );
        } finally {
          if (stagedPath) {
            await unlink(stagedPath).catch(() => {});
          }
        }
      }
    },
  );

  await Promise.all(workers);
  await appendQueue;
  console.log(
    `Finished: ${succeeded.toLocaleString()} uploaded, ${failed.toLocaleString()} failed`,
  );
  if (failed > 0) process.exitCode = 2;

  function logProgress(action, objectKey) {
    const processed = succeeded + failed;
    if (processed <= 10 || processed % 25 === 0 || processed === entries.length) {
      console.log(
        `[${processed.toLocaleString()}/${entries.length.toLocaleString()}] ${action}: ${objectKey}`,
      );
    }
  }
}

async function putWithRetry(entry, stagedPath, options) {
  let lastError;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      await runCommand(options.wrangler, [
        "r2",
        "object",
        "put",
        `${PRODUCTION_BUCKET}/${entry.object_key}`,
        "--file",
        stagedPath,
        "--content-type",
        entry.content_type,
        "--cache-control",
        entry.cache_control,
        "--remote",
        "--profile",
        options.profile,
      ], {
        env: wranglerEnvironment(options),
        cwd: options.wranglerCwd,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < options.maxAttempts) {
        await delay(Math.min(500 * 2 ** (attempt - 1), 5_000));
      }
    }
  }
  throw lastError;
}

async function stageVerifiedObject(entry, stagingDirectory) {
  const extension = path.posix.extname(entry.object_key);
  const stagedPath = path.join(
    stagingDirectory,
    `${entry.sha256}-${randomUUID()}${extension}`,
  );
  try {
    const sourcePath =
      entry.kind === "avatar"
        ? await validateAvatarSource(entry)
        : entry.local_path;
    await copyFile(sourcePath, stagedPath, constants.COPYFILE_EXCL);
    const info = await stat(stagedPath).catch(() => null);
    if (!info?.isFile()) {
      throw new Error(`unable to stage local derivative: ${entry.local_path}`);
    }
    if (info.size !== entry.bytes) {
      throw new Error(
        `staged size mismatch: expected ${entry.bytes}, found ${info.size}`,
      );
    }
    const actual = await hashFile(stagedPath);
    if (actual !== entry.sha256) {
      throw new Error(
        `staged SHA-256 mismatch: expected ${entry.sha256}, found ${actual}`,
      );
    }
    return stagedPath;
  } catch (error) {
    await unlink(stagedPath).catch(() => {});
    throw error;
  }
}

async function remoteObjectMatches(entry, options) {
  const destination = path.join(
    options.wranglerCwd,
    "remote-verification",
    `${entry.sha256}-${randomUUID()}${path.posix.extname(entry.object_key)}`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await runCommand(
      options.wrangler,
      [
        "r2",
        "object",
        "get",
        `${PRODUCTION_BUCKET}/${entry.object_key}`,
        "--file",
        destination,
        "--remote",
        "--profile",
        options.profile,
      ],
      {
        env: wranglerEnvironment(options),
        cwd: options.wranglerCwd,
      },
    );
    const info = await stat(destination).catch(() => null);
    if (!info?.isFile() || info.size !== entry.bytes) return false;
    return (await hashFile(destination)) === entry.sha256;
  } catch {
    return false;
  } finally {
    await unlink(destination).catch(() => {});
  }
}

async function loadLedger(ledgerPath, target) {
  const rows = await readNdjson(ledgerPath, true);
  const uploaded = new Map();
  for (const row of rows) {
    if (
      row.type === "uploaded" &&
      row.account_id === target.accountId &&
      row.profile === target.profile &&
      row.bucket === target.bucket &&
      row.bucket_created_at === target.bucketCreatedAt &&
      row.object_key &&
      row.upload_fingerprint
    ) {
      uploaded.set(row.object_key, row.upload_fingerprint);
    }
  }
  return uploaded;
}

async function preflightRemoteTarget(options) {
  const { stdout } = await runCommandCapture(
    options.wrangler,
    [
      "r2",
      "bucket",
      "info",
      PRODUCTION_BUCKET,
      "--json",
      "--profile",
      options.profile,
    ],
    {
      env: wranglerEnvironment(options),
      cwd: options.wranglerCwd,
    },
  );

  let bucket;
  try {
    bucket = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      "Wrangler returned non-JSON bucket metadata during the production preflight",
    );
  }
  if (bucket?.name !== PRODUCTION_BUCKET) {
    throw new Error(
      `production preflight returned the wrong bucket: ${bucket?.name ?? "(missing)"}`,
    );
  }
  if (
    typeof bucket.created !== "string" ||
    Number.isNaN(Date.parse(bucket.created))
  ) {
    throw new Error("production preflight did not return a valid bucket creation time");
  }

  console.log(
    `Verified remote target: account ${options.accountId}, profile ${options.profile}, bucket ${PRODUCTION_BUCKET}`,
  );
  return bucket;
}

async function acquireUploadLock(target, allowStaleRecovery = true) {
  const lockRoot = path.join(
    os.tmpdir(),
    "alex-sierra-wedding-r2-upload-locks",
  );
  const lockScope = sha256Text(
    JSON.stringify({
      account_id: target.accountId,
      bucket: target.bucket,
    }),
  ).slice(0, 24);
  const lockPath = path.join(lockRoot, `${lockScope}.lock`);
  await mkdir(lockRoot, { recursive: true });

  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = await readFile(path.join(lockPath, "owner.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (
      allowStaleRecovery &&
      owner?.hostname === os.hostname() &&
      Number.isSafeInteger(owner.pid) &&
      !processIsAlive(owner.pid)
    ) {
      await rm(lockPath, { recursive: true, force: true });
      return acquireUploadLock(target, false);
    }
    throw new Error(
      `another uploader holds the production R2 lock at ${lockPath}` +
        (owner?.pid ? ` (pid ${owner.pid} on ${owner.hostname})` : ""),
    );
  }

  try {
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        started_at: new Date().toISOString(),
        account_id: target.accountId,
        bucket: target.bucket,
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(lockPath, { recursive: true, force: true });
  };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function wranglerEnvironment(options) {
  const environment = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: options.accountId,
  };
  for (const name of WRANGLER_TARGET_OVERRIDE_VARIABLES) {
    delete environment[name];
  }
  return environment;
}

function assertProfileAuthenticationIsUnshadowed() {
  const shadowingVariables = WRANGLER_TARGET_OVERRIDE_VARIABLES.filter(
    (name) => process.env[name],
  );
  if (shadowingVariables.length > 0) {
    throw new Error(
      `the audited Wrangler profile and production API endpoint cannot be verified while these environment variables are set: ${shadowingVariables.join(
        ", ",
      )}`,
    );
  }
}

function uploadFingerprint(entry) {
  return sha256Text(
    [entry.sha256, entry.content_type, entry.cache_control].join("\0"),
  );
}

async function readNdjson(filePath, missingIsEmpty = false) {
  const body = await readFile(filePath, "utf8").catch((error) => {
    if (missingIsEmpty && error?.code === "ENOENT") return "";
    throw error;
  });
  const rows = [];
  for (const [index, line] of body.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      if (missingIsEmpty && index === body.split("\n").length - 1) continue;
      throw new Error(`invalid NDJSON at ${filePath}:${index + 1}`);
    }
  }
  return rows;
}

function validateEntries(entries) {
  const keys = new Set();
  for (const [index, entry] of entries.entries()) {
    const line = index + 1;
    for (const field of [
      "kind",
      "object_key",
      "local_path",
      "content_type",
      "cache_control",
      "sha256",
      "bytes",
    ]) {
      if (entry[field] == null) {
        throw new Error(`manifest line ${line} is missing ${field}`);
      }
    }
    if (
      !entry.object_key ||
      !entry.object_key.startsWith(PRODUCTION_PREFIX) ||
      path.posix.isAbsolute(entry.object_key) ||
      entry.object_key.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(entry.object_key) ||
      entry.object_key
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error(`manifest line ${line} has an unsafe object key`);
    }
    const photoKey = entry.object_key.match(
      /^wedding\/([a-f0-9]{2})\/p_([a-f0-9]{32})\/(thumb|display)-([a-f0-9]{20})\.(webp|avif|jpeg)$/,
    );
    const avatarKey = entry.object_key.match(
      /^wedding\/people\/(person_[a-f0-9]{32})\/avatar-([a-f0-9]{20})\.webp$/,
    );
    if (!photoKey && !avatarKey) {
      throw new Error(`manifest line ${line} has a non-production object key`);
    }
    let embeddedHash;
    let extension;
    if (photoKey) {
      const [, shard, photoHash, kind, photoEmbeddedHash, photoExtension] =
        photoKey;
      embeddedHash = photoEmbeddedHash;
      extension = photoExtension;
      if (
        entry.person_id != null ||
        entry.photo_id !== `p_${photoHash}` ||
        shard !== photoHash.slice(0, 2) ||
        entry.kind !== kind
      ) {
        throw new Error(`manifest line ${line} key identity does not match its row`);
      }
    } else {
      const [, personId, avatarEmbeddedHash] = avatarKey;
      embeddedHash = avatarEmbeddedHash;
      extension = "webp";
      if (
        entry.photo_id != null ||
        !PERSON_ID_PATTERN.test(entry.person_id) ||
        entry.person_id !== personId ||
        entry.kind !== "avatar"
      ) {
        throw new Error(`manifest line ${line} key identity does not match its row`);
      }
    }
    if (!path.isAbsolute(entry.local_path)) {
      throw new Error(`manifest line ${line} local_path must be absolute`);
    }
    if (
      avatarKey &&
      (!isPrivateAvatarCropPath(entry.local_path) ||
        path.extname(entry.local_path).toLowerCase() !== ".webp")
    ) {
      throw new Error(
        `manifest line ${line} avatar source must be a private WebP crop`,
      );
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`manifest line ${line} has an invalid SHA-256`);
    }
    if (!entry.sha256.startsWith(embeddedHash)) {
      throw new Error(
        `manifest line ${line} object key hash does not match its SHA-256`,
      );
    }
    if (!["image/avif", "image/jpeg", "image/webp"].includes(entry.content_type)) {
      throw new Error(`manifest line ${line} has an unsupported content_type`);
    }
    const expectedContentType = {
      avif: "image/avif",
      jpeg: "image/jpeg",
      webp: "image/webp",
    }[extension];
    if (entry.content_type !== expectedContentType) {
      throw new Error(
        `manifest line ${line} extension does not match its content_type`,
      );
    }
    if (entry.cache_control !== PRODUCTION_CACHE_CONTROL) {
      throw new Error(
        `manifest line ${line} must use the production immutable cache policy`,
      );
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      throw new Error(`manifest line ${line} has invalid bytes`);
    }
    if (keys.has(entry.object_key)) {
      throw new Error(`manifest contains duplicate object key: ${entry.object_key}`);
    }
    keys.add(entry.object_key);
  }
}

async function validateAvatarSources(entries) {
  for (const entry of entries) {
    if (entry.kind === "avatar") await validateAvatarSource(entry);
  }
}

async function validateAvatarSource(entry) {
  const sourcePath = await realpath(entry.local_path).catch(() => null);
  if (!sourcePath || !isPrivateAvatarCropPath(sourcePath)) {
    throw new Error(
      `avatar source is missing or outside the private media workspace: ${entry.local_path}`,
    );
  }
  const info = await stat(sourcePath).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`avatar source is not a regular file: ${entry.local_path}`);
  }
  if (info.size !== entry.bytes) {
    throw new Error(
      `avatar source size mismatch: expected ${entry.bytes}, found ${info.size}`,
    );
  }
  const actual = await hashFile(sourcePath);
  if (actual !== entry.sha256) {
    throw new Error(
      `avatar source SHA-256 mismatch: expected ${entry.sha256}, found ${actual}`,
    );
  }
  return sourcePath;
}

function isPrivateAvatarCropPath(candidate) {
  const absolute = path.resolve(candidate);
  const relative = path.relative(PRIVATE_MEDIA_ROOT, absolute);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  return relative.split(path.sep).includes("crops");
}

async function assertExecutable(command) {
  if (!command.includes(path.sep)) {
    // A bare executable name is resolved through PATH by spawn.
    await runCommand(command, ["--version"]);
    return;
  }
  await access(command).catch(() => {
    throw new Error(`Wrangler executable not found: ${command}`);
  });
}

async function runCommand(command, args, options = {}) {
  await runCommandCapture(command, args, options);
}

async function runCommandCapture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      cwd: options.cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 16_384) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} exited ${code}: ${(stderr || stdout).trim().slice(0, 4_000)}`,
          ),
        );
      }
    });
  });
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

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(args) {
  const options = {
    apply: false,
    force: false,
    help: false,
    manifest: null,
    profile: null,
    accountId: null,
    ledger: null,
    wrangler: "wrangler",
    concurrency: 4,
    maxAttempts: 3,
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
      case "--manifest":
        options.manifest = valueFor(index, argument);
        index += 1;
        break;
      case "--profile":
        options.profile = valueFor(index, argument);
        index += 1;
        break;
      case "--account-id":
        options.accountId = valueFor(index, argument).toLowerCase();
        index += 1;
        break;
      case "--ledger":
        options.ledger = valueFor(index, argument);
        index += 1;
        break;
      case "--wrangler":
        options.wrangler = valueFor(index, argument);
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = positiveInteger(valueFor(index, argument), argument);
        index += 1;
        break;
      case "--max-attempts":
        options.maxAttempts = positiveInteger(valueFor(index, argument), argument);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}\n\n${HELP.trim()}`);
    }
  }
  return options;
}

function validateOptions(options) {
  if (!options.manifest) throw new Error("--manifest is required");
  if (!options.profile) throw new Error("--profile is required");
  if (!options.accountId) throw new Error("--account-id is required");
  if (!/^[A-Za-z0-9_-]+$/.test(options.profile)) {
    throw new Error(
      "--profile may contain only letters, numbers, hyphens, and underscores",
    );
  }
  if (!/^[a-f0-9]{32}$/.test(options.accountId)) {
    throw new Error("--account-id must be exactly 32 hexadecimal characters");
  }
  if (options.concurrency < 1 || options.concurrency > 32) {
    throw new Error("--concurrency must be between 1 and 32");
  }
  if (options.maxAttempts < 1 || options.maxAttempts > 10) {
    throw new Error("--max-attempts must be between 1 and 10");
  }
}

function positiveInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
