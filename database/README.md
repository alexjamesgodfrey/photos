# Wedding gallery database

`001_wedding_photos.sql` is an idempotent PostgreSQL migration for PlanetScale.
It creates only the read-only gallery metadata model:

- `wedding_photos.albums`
- `wedding_photos.photos`
- `wedding_photos.import_runs`

Authentication is intentionally application-owned. There are no user, session,
upload, or authorization tables.

The gallery API's stable photo contract is:

```text
id, album_id, source_fingerprint, original_filename, captured_at,
album_position, width, height, thumb_key, display_key, blur_data_url,
published, created_at, updated_at
```

Additional columns retain derivative integrity, dimensions, import provenance,
and an allow-listed non-location metadata object.

Apply it through the PlanetScale console or with a PostgreSQL client:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f database/001_wedding_photos.sql
```

The generated import batches use upserts and stage new rows unpublished, so
replaying the same complete manifest is safe and a new album is not exposed
partially. The final transaction verifies the staged count, publishes the run,
updates aggregates, and marks it complete. Apply the schema migration before
any generated batch.

## Human-reviewed person labels

`002_photo_people.sql` prepares the production relationship tables used by the
gallery's person filter:

- `wedding_photos.people`
- `wedding_photos.photo_people`

Each person row may also reference one content-addressed, metadata-free square
avatar in the private R2 bucket. The migration enforces all-or-none avatar
metadata, exact key/person identity, SHA-prefix agreement, and positive
dimensions.

Do not apply or import this data merely to run the local labeler. Finish the
human review first, validate the private export, upload and remotely verify the
selected avatars, then apply the migration before importing the generated SQL.
Production receives names, photo associations, and avatar object metadata only;
face IDs, unselected crops, embeddings, landmarks, and bounding boxes remain
local.
