# Production inventory

This file records the non-secret production state for the wedding gallery. It
is intentionally safe to commit: no access code, database URL, token, password,
cookie secret, or media-signing secret belongs here.

Last verified: July 27, 2026.

## Public application

- URL: `https://photos.alexgodfrey.com`
- Vercel team/project: `godfreyy/photos`
- Vercel project ID: `prj_boZD8ntTugSV14XhmL3fYGMWAs57`
- Production branch: `master`
- Runtime region: `pdx1`
- Authentication: one shared, case-sensitive access code
- Session: signed, `HttpOnly`, `Secure`, `SameSite=Lax`, host-only cookie
- Firewall: `POST /api/auth/code` is limited to 5 requests per 60 seconds per
  source IP

The access-code digest, session secret, media-signing secret, database URL, and
media URL are production-only Vercel environment variables. Old Supabase
environment variables have been removed.

## Metadata database

- PlanetScale organization/database/branch: `godfrey/tracking-food/main`
- PostgreSQL schema: `wedding_photos`
- Exposed album: `wedding`
- Published photos: 990
- Import run: `run_20260727011503_70060a9d4509`
- Manifest SHA-256:
  `c6e32657726331d5e5cf763d1bb08d82d3bff9ff362e682a638ee11940746060`

Vercel uses a dedicated role with only schema `USAGE` and table `SELECT`.
Production verification must prove that the role cannot `INSERT`, `UPDATE`,
`DELETE`, or create objects. Import credentials are temporary and must never be
configured in Vercel.

## Media delivery

- Worker:
  `https://alex-sierra-wedding-media.alexjamesgodfrey.workers.dev`
- Private R2 bucket: `alex-sierra-wedding-photos`
- Stored objects: 1,980 (`990` thumbnails and `990` display images)
- Stored bytes: 419,297,516 (`399.873 MiB`)
- Format: metadata-free WebP
- Variants: 640 px thumbnails and 2560 px display images

The bucket has no public `r2.dev` endpoint. The Worker validates a six-hour
signed URL before accessing the private R2 binding. Its internal cache key
excludes signature parameters, while object keys are content-addressed and safe
for one-year edge caching. Browser caching never outlives the signed URL.

`GALLERY_SESSION_SECRET` is Vercel-only. `MEDIA_SIGNING_SECRET` is independently
generated and is the only secret shared between Vercel and the Worker.

## Release verification

Every production release should verify all of the following:

1. `npm test`, `npm run typecheck`, `npm run build`,
   `npm run worker:check`, `npm audit`, and `git diff --check` pass.
2. An unauthenticated gallery/API request is rejected.
3. A wrong access code returns `401`, and the firewall returns `429` after the
   configured threshold.
4. The correct code issues the expected secure cookie.
5. Album, newest, and oldest pagination each report a total of 990.
6. A signed thumbnail and display object return WebP bytes with matching
   `Content-Length`; a modified signature returns `401`.
7. A second media request is a Cloudflare cache hit.
8. The R2 upload ledger is re-run so every remote object is downloaded and
   checked against its planned byte count and SHA-256.
9. The custom domain serves the promoted deployment with the expected CSP,
   HSTS, clickjacking, MIME-sniffing, referrer, permissions, and no-index
   headers.

## Secret rotation

Rotate the app session secret, media-signing secret, and access code
independently. A media-signing rotation requires updating both Vercel and the
Worker before publishing a fresh application deployment. A session rotation
logs out existing viewers. An access-code rotation changes only the digest in
Vercel and does not reveal the human code to the repository.
