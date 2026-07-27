BEGIN;

CREATE TABLE IF NOT EXISTS wedding_photos.people (
  id text PRIMARY KEY,
  album_id text NOT NULL
    REFERENCES wedding_photos.albums(id) ON DELETE CASCADE,
  slug text NOT NULL,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (album_id, slug)
);

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
  'Human-reviewed people labels for an album. No face embeddings or biometric crops.';

COMMENT ON TABLE wedding_photos.photo_people IS
  'Human-reviewed photo-to-person associations. Face geometry remains local only.';

COMMIT;
