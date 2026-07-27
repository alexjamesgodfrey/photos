# Architecture and legacy map

## What the repository used to do

The original application was a client-heavy Supabase photo-sharing site:

1. A guest selected a name from a hard-coded attendee list.
2. Supabase created an anonymous user and the browser saved the display name in
   local storage.
3. The gallery queried `public.wedding_uploads` directly from the browser,
   subscribed to realtime inserts, and generated public Supabase Storage URLs.
4. Guests compressed images in the browser, uploaded them through TUS, and
   inserted metadata rows.

That model combined identity, contribution, storage, and viewing. It also made
the browser responsible for most authorization and exposed the underlying
storage URL.

## Current boundaries

The current repository has four deliberately small systems.

### 1. Web application

The Next.js Pages Router application renders the private entrance and gallery.
Its API verifies a signed, HttpOnly session cookie before returning metadata.
There is no client-side database credential and no upload surface.

Core browser data is the `GalleryPhoto` shape:

```text
id, thumbUrl, displayUrl, width, height, capturedAt, filename, blurDataUrl
```

### 2. Metadata database

PlanetScale Postgres stores albums, import provenance, immutable object keys,
dimensions, checksums, sort position, and a small allow-list of safe camera
metadata. It does not store image bytes, users, access codes, or sessions.

The application credential is read-only. A separate operator credential applies
the schema and generated transactional imports.

### 3. Media delivery

R2 stores only 640 px thumbnails and 2560 px display WebP derivatives. The
bucket is private. The outer Worker validates a short-lived HMAC URL, strips
its credentials from the cache key, and delegates to a cache-enabled internal
entrypoint. The session-cookie secret never leaves Vercel. Content-addressed
keys allow one-year immutable edge caching without routine purge operations.

### 4. Offline ingestion

The local media pipeline inventories an exported Photos album, auto-orients and
converts images to sRGB, strips EXIF/XMP/IPTC data, produces content-addressed
derivatives, and writes integrity-checked upload and SQL manifests. Append-only
state makes interrupted transforms and uploads resumable.

## Request flows

### Login

```text
POST /api/auth/code
  -> hash candidate with SHA-256
  -> constant-time comparison with configured digest
  -> issue v1.expiry.HMAC HttpOnly cookie
  -> redirect browser to /gallery
```

### Gallery page

```text
SSR cookie guard
  -> GET /api/photos?sort=...&cursor=...
  -> verify cookie
  -> read published rows from PlanetScale
  -> attach signed thumbnail/display URLs
  -> render lazy masonry pages and lightbox
```

### Image

```text
signed Worker URL
  -> validate HMAC and expiry
  -> normalize URL without signed query parameters
  -> edge-cache lookup
  -> private R2 binding on miss
  -> immutable WebP response
```

## Configuration ownership

| Setting | Vercel | Cloudflare | Local operator |
| --- | :---: | :---: | :---: |
| PlanetScale read URL | yes | no | optional |
| Access-code digest | yes | no | generated |
| Session-cookie secret | yes | no | generated |
| Media-signing secret | yes | yes | generated |
| Worker base URL | yes | no | recorded |
| R2 bucket binding | no | yes | configured |
| PlanetScale import URL | no | no | temporary |

## Intentional non-features

- No guest uploads.
- No named users or attendee list.
- No anonymous third-party auth.
- No originals, RAW files, or Live Photo video delivery.
- No GPS or opaque source metadata in the database.
- No public R2 endpoint.
- No routine cache purge; new bytes receive new keys.

## Production deployment

The Cloudflare, PlanetScale, and Vercel resources are configured and live. Their
non-secret identifiers, release counts, security boundaries, and verification
procedure are recorded in [production.md](production.md). The human access code,
database credentials, and signing secrets are deliberately absent from Git.
