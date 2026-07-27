BEGIN;

CREATE TABLE IF NOT EXISTS wedding_photos.people (
  id text PRIMARY KEY,
  album_id text NOT NULL
    REFERENCES wedding_photos.albums(id) ON DELETE CASCADE,
  slug text NOT NULL,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  avatar_key text,
  avatar_sha256 char(64),
  avatar_width integer,
  avatar_height integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (album_id, slug),
  CONSTRAINT people_avatar_metadata_check CHECK (
    (
      avatar_key IS NULL
      AND avatar_sha256 IS NULL
      AND avatar_width IS NULL
      AND avatar_height IS NULL
    )
    OR
    (
      avatar_key IS NOT NULL
      AND avatar_sha256 IS NOT NULL
      AND avatar_width IS NOT NULL
      AND avatar_height IS NOT NULL
      AND length(avatar_key) BETWEEN 1 AND 1024
      AND avatar_key ~
        '^wedding/people/person_[a-f0-9]{32}/avatar-[a-f0-9]{20}[.]webp$'
      AND split_part(avatar_key, '/', 3) = id
      AND avatar_sha256 ~ '^[a-f0-9]{64}$'
      AND substring(
        avatar_key FROM 'avatar-([a-f0-9]{20})[.]webp$'
      ) = left(avatar_sha256, 20)
      AND avatar_width > 0
      AND avatar_height > 0
    )
  )
);

ALTER TABLE wedding_photos.people
  ADD COLUMN IF NOT EXISTS avatar_key text,
  ADD COLUMN IF NOT EXISTS avatar_sha256 char(64),
  ADD COLUMN IF NOT EXISTS avatar_width integer,
  ADD COLUMN IF NOT EXISTS avatar_height integer;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'wedding_photos.people'::regclass
      AND conname = 'people_avatar_metadata_check'
  ) THEN
    ALTER TABLE wedding_photos.people
      ADD CONSTRAINT people_avatar_metadata_check CHECK (
        (
          avatar_key IS NULL
          AND avatar_sha256 IS NULL
          AND avatar_width IS NULL
          AND avatar_height IS NULL
        )
        OR
        (
          avatar_key IS NOT NULL
          AND avatar_sha256 IS NOT NULL
          AND avatar_width IS NOT NULL
          AND avatar_height IS NOT NULL
          AND length(avatar_key) BETWEEN 1 AND 1024
          AND avatar_key ~
            '^wedding/people/person_[a-f0-9]{32}/avatar-[a-f0-9]{20}[.]webp$'
          AND split_part(avatar_key, '/', 3) = id
          AND avatar_sha256 ~ '^[a-f0-9]{64}$'
          AND substring(
            avatar_key FROM 'avatar-([a-f0-9]{20})[.]webp$'
          ) = left(avatar_sha256, 20)
          AND avatar_width > 0
          AND avatar_height > 0
        )
      );
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS wedding_photos.photo_people (
  photo_id text NOT NULL
    REFERENCES wedding_photos.photos(id) ON DELETE CASCADE,
  person_id text NOT NULL
    REFERENCES wedding_photos.people(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (photo_id, person_id)
);

CREATE INDEX IF NOT EXISTS photo_people_person_photo_idx
  ON wedding_photos.photo_people (person_id, photo_id);

COMMENT ON TABLE wedding_photos.people IS
  'Human-reviewed people labels and one metadata-free avatar per person. No face embeddings or geometry.';

COMMENT ON TABLE wedding_photos.photo_people IS
  'Human-reviewed photo-to-person associations. Face geometry remains local only.';

COMMENT ON COLUMN wedding_photos.people.avatar_key IS
  'Private R2 object key for the selected metadata-free square avatar derivative.';

COMMENT ON COLUMN wedding_photos.people.avatar_sha256 IS
  'SHA-256 of the immutable avatar derivative used to verify imports and uploads.';

COMMIT;
