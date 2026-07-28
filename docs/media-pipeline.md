# Wedding media pipeline

This pipeline turns a large Photos.app export into a small, privacy-safe web
library. It uploads only display derivatives—not the 1 TB original library.

## Output profile

The default profile produces two immutable WebP objects per photo:

| Variant | Longest edge | Quality | Gallery use |
| --- | ---: | ---: | --- |
| thumbnail | 640 px | 76 | grid and initial load |
| display | 2560 px | 84 | lightbox/full-screen view |

Both derivatives are auto-oriented, converted to sRGB, and written without
EXIF, XMP, or IPTC data. The script only allow-lists non-location capture and
camera fields into the private database manifest. It does not request or retain
GPS fields. Original files are never included in the R2 upload plan.

Object names include a derivative content hash:

```text
wedding/ab/p_abcd…/thumb-0123….webp
wedding/ab/p_abcd…/display-4567….webp
```

That makes `Cache-Control: public, max-age=31536000, immutable` safe. A changed
encoding profile creates a new URL rather than requiring cache purges.

## 1. Export from Photos

Export the `Wedding Photos` album to an external working disk. Keep the Photos
library as the source of truth; do not delete or relocate it.

For the best capture dates and maximum flexibility, export unmodified
originals. This requires source-sized temporary disk space. If that is not
practical, export high-quality JPEGs at a dimension above 2560 px and include
date metadata; the pipeline will still strip metadata from the uploaded
derivatives.

The processor accepts JPEG, PNG, HEIC/HEIF, TIFF, WebP, and AVIF. It deliberately
ignores video companions from Live Photos. Some RAW codecs and some HEIC variants
depend on the codecs available in the installed Sharp/libvips build; failed
files are recorded and do not stop the rest of the run. Export those specific
files as JPEG and resume.

Before a full run, confirm there is enough space for:

- the Photos export;
- both web derivatives (usually far smaller than the originals);
- temporary room for several images at the selected concurrency.

## 2. Install dependencies

The project pins `sharp`, `exifr`, and Wrangler as development dependencies; no
credentials are embedded. Install the lockfile exactly:

```bash
npm ci
```

Node.js 20 or newer is recommended.

## 3. Scan, then generate

Dry-run first. It recursively inventories supported images but does not hash,
transform, or write them:

```bash
node scripts/ingest-wedding-photos.mjs \
  --input "/Volumes/Wedding Work/Wedding Photos export"
```

Test the real encoders on a small sample:

```bash
node scripts/ingest-wedding-photos.mjs \
  --input "/Volumes/Wedding Work/Wedding Photos export" \
  --output "/Volumes/Wedding Work/wedding-web" \
  --limit 25 \
  --apply
```

Then run the complete album without `--limit`:

```bash
node scripts/ingest-wedding-photos.mjs \
  --input "/Volumes/Wedding Work/Wedding Photos export" \
  --output "/Volumes/Wedding Work/wedding-web" \
  --album-id wedding \
  --album-slug wedding \
  --album-title "Wedding Photos" \
  --prefix wedding \
  --concurrency 4 \
  --apply
```

The work directory contains:

```text
wedding-web/
  objects/                       # exact R2 key layout
  manifest/
    album.json                   # album, run, and profile metadata
    photos.ndjson                # database source manifest
    upload-plan.ndjson           # local object paths + HTTP metadata
  .state/
    ingest.ndjson                # append-only transform resume state
```

The resume signature includes relative path, source size, modification time,
tool version, Sharp/libvips encoder versions, and the complete derivative
profile. Successful objects are checked before they are skipped. An interrupted
append can at worst cause one photo to be safely reprocessed. Exact duplicate
source bytes collapse to one gallery photo with deterministic metadata from the
lexically first source path.

`--force` rebuilds all sources. A profile change automatically creates new
content-addressed object keys; old remote objects are not deleted automatically.

## 4. Generate idempotent PlanetScale batches

Dry-run:

```bash
node scripts/generate-db-import.mjs \
  --manifest-dir "/Volumes/Wedding Work/wedding-web/manifest"
```

Write SQL batches:

```bash
node scripts/generate-db-import.mjs \
  --manifest-dir "/Volumes/Wedding Work/wedding-web/manifest" \
  --output "/Volumes/Wedding Work/wedding-web/db-import" \
  --batch-size 250 \
  --authoritative \
  --apply
```

`--authoritative` unpublishes existing album rows absent from the manifest. Use
it only after a complete run, never after `--limit`. The generator enforces this
by rejecting limited or failed manifests. New rows remain unpublished while the
batches load; the final transaction validates the complete staged count,
publishes the current run, performs any authoritative unpublish, recomputes the
album aggregates, and marks the run complete. Existing published rows stay
visible until that final transaction.

Every generated file is transactional and uses `ON CONFLICT` upserts. The
generator verifies the manifest SHA-256 and photo count before writing SQL. It
writes a manifest-hash/run/batch-size-specific subdirectory beneath `--output`,
so a prior run's stale batch files cannot be included accidentally.

Do not apply the SQL yet. Upload and verify every R2 object first, so published
database rows can never point at an object that is still in a multi-hour upload.

## 5. Upload immutable objects to R2

The sole production destination is the existing private R2 bucket
`alex-sierra-wedding-photos`. The uploader does not accept a bucket argument,
cannot create a bucket, and never creates or stores a Cloudflare token. It also
rejects keys outside `wedding/` and any upload plan that drops the immutable
one-year R2 object policy. It accepts only two audited manifest shapes:

- source-derived `thumb` and `display` derivatives from the media ingest;
- one metadata-free `avatar` WebP selected by the completed local face review.

Avatar keys must have the exact content-addressed form
`wedding/people/<person-id>/avatar-<sha-prefix>.webp`. Their source paths must
resolve inside an ignored `.media-staging/**/crops/` directory. The uploader
rejects a missing file, path escape, symlink escape, person/key mismatch, byte
count mismatch, SHA-256 mismatch, wrong MIME type, or mutable cache policy.

Use an existing named Wrangler authentication profile and the exact Cloudflare
account ID that owns the bucket:

```bash
WRANGLER_BIN="./node_modules/.bin/wrangler"
WEDDING_WRANGLER_PROFILE="<existing-profile-name>"
WEDDING_CLOUDFLARE_ACCOUNT_ID="<32-character-account-id>"

"$WRANGLER_BIN" auth list
```

Credential and endpoint override environment variables such as
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_BASE_URL`, `CF_API_BASE_URL`, and
`WRANGLER_API_ENVIRONMENT` must be unset. They can override named profiles or
redirect authenticated API traffic, so the uploader rejects and strips them.
`--profile` is required and is passed explicitly to every remote Wrangler
command.

Offline dry-run:

```bash
node scripts/upload-r2.mjs \
  --manifest "/Volumes/Wedding Work/wedding-web/manifest/upload-plan.ndjson" \
  --profile "$WEDDING_WRANGLER_PROFILE" \
  --account-id "$WEDDING_CLOUDFLARE_ACCOUNT_ID" \
  --wrangler "$WRANGLER_BIN"
```

Upload:

```bash
node scripts/upload-r2.mjs \
  --manifest "/Volumes/Wedding Work/wedding-web/manifest/upload-plan.ndjson" \
  --profile "$WEDDING_WRANGLER_PROFILE" \
  --account-id "$WEDDING_CLOUDFLARE_ACCOUNT_ID" \
  --wrangler "$WRANGLER_BIN" \
  --concurrency 4 \
  --apply
```

Before calculating upload skips or issuing any PUT, `--apply` runs a remote
`r2 bucket info` preflight with the explicit profile and account ID. It must
authenticate successfully and return the exact
`alex-sierra-wedding-photos` bucket; otherwise the process stops without
uploading. All remote Wrangler calls run from an isolated temporary directory,
so a project-level Wrangler config or `.env` cannot override the audited target.
Successful PUTs go to an append-only ledger scoped by the verified account ID,
explicit profile, exact bucket, and the bucket creation timestamp. A deleted and
recreated bucket therefore cannot inherit an old ledger. Before honoring any
ledger skip, the uploader downloads that remote object and verifies its size and
SHA-256; a missing or changed object becomes pending again. Skip fingerprints
also include MIME type and Cache-Control, so planned HTTP metadata changes
trigger a new PUT.

Before each PUT, the uploader copies the source derivative to a private,
per-run staging directory, verifies the staged size and SHA-256, and gives
Wrangler that exact staged pathname. This closes the check/upload race if the
source export changes concurrently. Object-key hashes, variants, photo IDs,
extensions, MIME types, and immutable cache policy must all agree with the
manifest.

Only one uploader process per account/bucket can run on the machine at a time;
an atomic lock protects pending-set calculation, PUTs, and ledger appends.
Failed objects are retried with bounded backoff and remain pending on the next
run. The uploader’s `--force` option re-uploads everything; it is not forwarded
to Wrangler’s unrelated data-catalog `--force` flag.

After face review is complete, generate and upload the selected avatars
separately:

```bash
npm run faces:export -- --apply

npm run faces:upload-avatars -- \
  --profile "$WEDDING_WRANGLER_PROFILE" \
  --account-id "$WEDDING_CLOUDFLARE_ACCOUNT_ID" \
  --wrangler "$WRANGLER_BIN" \
  --concurrency 4 \
  --apply
```

The private plan is
`.media-staging/faces/export/avatar-upload-plan.ndjson`. Never construct a plan
from every file in `.media-staging/faces/crops`; only the one verified avatar
selected for each named person belongs in R2. Re-run the avatar command until
every ledger-backed object is remotely downloaded and hash-verified before
applying `.media-staging/faces/export/people.sql`.

Wrangler launches one process per object. Start with concurrency 4, watch CPU,
disk, and network utilization, and raise it gradually (usually no higher than
8) for a large import.

## 6. Publish the database metadata

Only after the R2 uploader reports zero pending/failed objects, apply the schema
and the generated run-specific SQL directory with a database URL supplied by the
environment:

```bash
set -e

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f database/001_wedding_photos.sql

IMPORT_DIR="/Volumes/Wedding Work/wedding-web/db-import/import-<generated-run>"
for file in \
  "$IMPORT_DIR/000-album-and-run.sql" \
  "$IMPORT_DIR"/photos-*.sql \
  "$IMPORT_DIR/999-finalize-run.sql"
do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done
```

Use the exact directory printed by `generate-db-import.mjs`; do not glob the
parent `db-import` directory. The setup file must run before every photo batch,
and the finalizer must run last.

## Delivery and access-code boundary

The first production deployment uses the authenticated media Worker on its
Cloudflare-provided hostname:

```text
https://alex-sierra-wedding-media.<account-subdomain>.workers.dev
```

Set the application’s `MEDIA_BASE_URL` to the exact URL Wrangler prints after
deploying `cloudflare/wrangler.jsonc`. The Worker validates the signed request,
reads the private `alex-sierra-wedding-photos` binding, and controls caching.
Configure the Worker's `MEDIA_SIGNING_SECRET` with the same independent value
used by Vercel; never configure `GALLERY_SESSION_SECRET` on Cloudflare. Do not
enable the bucket’s public `r2.dev` URL.

A custom media domain is optional later. Add one only after the chosen DNS zone
has been onboarded to Cloudflare, and route it to the authenticated Worker—not
directly to the R2 bucket. Until then, `workers.dev` is the supported production
origin and does not block launch.

The object keys are unguessable but that is not authentication. Vercel keeps a
session-cookie secret that is never configured on Cloudflare, plus a distinct
media-signing secret shared with the Worker. The Worker accepts only signed
media URLs and never needs the application cookie or human access code. Keep
Vercel application traffic DNS-only rather than proxying the Vercel hostname
through Cloudflare.

Because keys are immutable, normal changes require no cache purge. Purge only
HTML/API responses or a mistakenly published object URL; never make purging part
of the routine import path.

## Operational checks before publishing

1. Review at least 25 portrait and landscape derivatives for orientation,
   sharpness, skin tone, and animation smoothness in the gallery.
2. Confirm `photos.ndjson` contains no GPS fields and the uploaded derivatives
   have no EXIF location metadata.
3. Compare discovered, unique, failed, uploaded, and imported counts.
4. Load the `workers.dev` media origin from at least two regions/devices and
   verify `Cache-Control` plus a Cloudflare cache hit on the second request.
5. Verify an unauthenticated browser cannot load the gallery or protected media.
6. Keep the local work directory and state ledgers until the production album
   has been fully reviewed.
