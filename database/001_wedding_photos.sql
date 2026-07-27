BEGIN;

CREATE SCHEMA IF NOT EXISTS wedding_photos;

CREATE TABLE IF NOT EXISTS wedding_photos.albums (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text,
  cover_photo_id text,
  default_sort text NOT NULL DEFAULT 'captured_at_asc'
    CHECK (default_sort IN (
      'captured_at_asc',
      'captured_at_desc',
      'album_position_asc',
      'album_position_desc'
    )),
  photo_count bigint NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
  captured_at_min timestamptz,
  captured_at_max timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    captured_at_min IS NULL
    OR captured_at_max IS NULL
    OR captured_at_min <= captured_at_max
  )
);

CREATE TABLE IF NOT EXISTS wedding_photos.import_runs (
  id text PRIMARY KEY,
  album_id text NOT NULL
    REFERENCES wedding_photos.albums(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'completed_with_errors', 'failed')),
  tool_version text NOT NULL,
  profile_fingerprint char(64) NOT NULL,
  manifest_sha256 char(64),
  discovered_count bigint NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  imported_count bigint NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  skipped_count bigint NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count bigint NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  complete_source_set boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wedding_photos.photos (
  id text PRIMARY KEY,
  album_id text NOT NULL
    REFERENCES wedding_photos.albums(id) ON DELETE CASCADE,
  imported_run_id text
    REFERENCES wedding_photos.import_runs(id) ON DELETE SET NULL,

  source_fingerprint char(64) NOT NULL,
  original_filename text NOT NULL,
  source_bytes bigint NOT NULL CHECK (source_bytes >= 0),
  source_width integer NOT NULL CHECK (source_width > 0),
  source_height integer NOT NULL CHECK (source_height > 0),

  captured_at timestamptz,
  captured_at_source text NOT NULL DEFAULT 'unknown'
    CHECK (captured_at_source IN ('exif', 'filesystem', 'unknown')),
  album_position integer NOT NULL CHECK (album_position >= 0),
  media_type text NOT NULL DEFAULT 'image' CHECK (media_type = 'image'),
  published boolean NOT NULL DEFAULT true,

  thumb_key text NOT NULL UNIQUE,
  thumb_sha256 char(64) NOT NULL,
  thumb_width integer NOT NULL CHECK (thumb_width > 0),
  thumb_height integer NOT NULL CHECK (thumb_height > 0),
  thumb_bytes bigint NOT NULL CHECK (thumb_bytes > 0),

  display_key text NOT NULL UNIQUE,
  display_sha256 char(64) NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  display_bytes bigint NOT NULL CHECK (display_bytes > 0),

  blur_data_url text,
  dominant_color char(7),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (album_id, source_fingerprint),
  CHECK (dominant_color IS NULL OR dominant_color ~ '^#[0-9a-fA-F]{6}$'),
  CHECK (
    blur_data_url IS NULL
    OR blur_data_url LIKE 'data:image/%;base64,%'
  )
);

CREATE INDEX IF NOT EXISTS photos_published_position_idx
  ON wedding_photos.photos (album_id, published, album_position, id);

CREATE INDEX IF NOT EXISTS photos_published_captured_at_idx
  ON wedding_photos.photos (
    album_id,
    published,
    captured_at,
    album_position,
    id
  );

CREATE INDEX IF NOT EXISTS photos_published_captured_at_desc_idx
  ON wedding_photos.photos (
    album_id,
    captured_at DESC NULLS LAST,
    album_position ASC,
    id ASC
  )
  WHERE published = true;

CREATE INDEX IF NOT EXISTS photos_imported_run_idx
  ON wedding_photos.photos (imported_run_id);

CREATE INDEX IF NOT EXISTS import_runs_album_started_at_idx
  ON wedding_photos.import_runs (album_id, started_at DESC);

COMMENT ON SCHEMA wedding_photos IS
  'Read-only wedding gallery metadata. Authentication stays in the application.';

COMMENT ON COLUMN wedding_photos.photos.source_fingerprint IS
  'Content hash of the locally exported source; the source object is not uploaded.';

COMMENT ON COLUMN wedding_photos.photos.metadata IS
  'Non-sensitive allow-listed metadata only. GPS and raw EXIF are deliberately excluded.';

COMMIT;
