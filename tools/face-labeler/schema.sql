PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS workspace (
  id integer PRIMARY KEY CHECK (id = 1),
  schema_version integer NOT NULL,
  album_id text NOT NULL,
  source_manifest_sha256 text NOT NULL CHECK (length(source_manifest_sha256) = 64),
  detector_sha256 text NOT NULL CHECK (length(detector_sha256) = 64),
  embedder_sha256 text NOT NULL CHECK (length(embedder_sha256) = 64),
  pipeline_version text NOT NULL,
  config_json text NOT NULL,
  cluster_run_key text,
  clustered_at text,
  action_high_watermark integer NOT NULL DEFAULT 0 CHECK (action_high_watermark >= 0),
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id text PRIMARY KEY,
  album_position integer NOT NULL UNIQUE CHECK (album_position >= 0),
  source_fingerprint text NOT NULL UNIQUE CHECK (length(source_fingerprint) = 64),
  display_relpath text NOT NULL UNIQUE,
  display_sha256 text NOT NULL CHECK (length(display_sha256) = 64),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  scan_key text NOT NULL CHECK (length(scan_key) = 64),
  scan_status text NOT NULL DEFAULT 'pending'
    CHECK (scan_status IN ('pending', 'processing', 'complete', 'error')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  face_count integer NOT NULL DEFAULT 0 CHECK (face_count >= 0),
  scan_error text,
  processed_at text
);

CREATE TABLE IF NOT EXISTS people (
  id text PRIMARY KEY,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  name_key text NOT NULL UNIQUE COLLATE NOCASE,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS clusters (
  id text PRIMARY KEY,
  origin text NOT NULL CHECK (origin IN ('automatic', 'manual')),
  status text NOT NULL DEFAULT 'unreviewed'
    CHECK (status IN ('unreviewed', 'labeled', 'unknown', 'ignored')),
  person_id text REFERENCES people(id) ON DELETE SET NULL,
  representative_face_id text,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  reviewed_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CHECK ((status = 'labeled') = (person_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS faces (
  id text PRIMARY KEY,
  photo_id text NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  cluster_id text REFERENCES clusters(id) ON DELETE SET NULL,
  person_id text REFERENCES people(id) ON DELETE SET NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  bbox_x real NOT NULL CHECK (bbox_x >= 0 AND bbox_x <= 1),
  bbox_y real NOT NULL CHECK (bbox_y >= 0 AND bbox_y <= 1),
  bbox_width real NOT NULL CHECK (bbox_width > 0 AND bbox_width <= 1),
  bbox_height real NOT NULL CHECK (bbox_height > 0 AND bbox_height <= 1),
  landmarks_json text NOT NULL,
  detection_score real NOT NULL CHECK (detection_score >= 0 AND detection_score <= 1),
  width_px integer NOT NULL CHECK (width_px > 0),
  height_px integer NOT NULL CHECK (height_px > 0),
  quality text NOT NULL CHECK (quality IN ('clusterable', 'manual_only')),
  quality_score real NOT NULL CHECK (quality_score >= 0 AND quality_score <= 1),
  embedding_f32 blob,
  embedding_dim integer CHECK (embedding_dim IS NULL OR embedding_dim > 0),
  crop_relpath text NOT NULL UNIQUE,
  crop_sha256 text NOT NULL CHECK (length(crop_sha256) = 64),
  status text NOT NULL DEFAULT 'unreviewed'
    CHECK (status IN ('unreviewed', 'labeled', 'unknown', 'ignored')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (photo_id, ordinal),
  CHECK ((status = 'labeled') = (person_id IS NOT NULL)),
  CHECK (
    (embedding_f32 IS NULL AND embedding_dim IS NULL)
    OR (embedding_f32 IS NOT NULL AND embedding_dim IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS cannot_links (
  face_id_a text NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
  face_id_b text NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('same_photo', 'manual_split')),
  created_at text NOT NULL,
  PRIMARY KEY (face_id_a, face_id_b),
  CHECK (face_id_a < face_id_b)
);

CREATE TABLE IF NOT EXISTS cluster_suggestions (
  cluster_id_a text NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  cluster_id_b text NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  similarity_max real NOT NULL,
  similarity_median real NOT NULL,
  similarity_min real NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at text NOT NULL,
  PRIMARY KEY (cluster_id_a, cluster_id_b),
  CHECK (cluster_id_a < cluster_id_b)
);

CREATE TABLE IF NOT EXISTS actions (
  id integer PRIMARY KEY AUTOINCREMENT,
  client_mutation_id text NOT NULL UNIQUE,
  action_type text NOT NULL,
  payload_json text NOT NULL,
  inverse_json text NOT NULL,
  created_at text NOT NULL,
  undone_at text
);

CREATE INDEX IF NOT EXISTS photos_scan_queue_idx
  ON photos (scan_status, album_position);
CREATE INDEX IF NOT EXISTS faces_photo_idx
  ON faces (photo_id, ordinal);
CREATE INDEX IF NOT EXISTS faces_cluster_status_idx
  ON faces (cluster_id, status);
CREATE INDEX IF NOT EXISTS faces_person_status_idx
  ON faces (person_id, status);
CREATE INDEX IF NOT EXISTS clusters_status_idx
  ON clusters (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS cluster_suggestions_queue_idx
  ON cluster_suggestions (status, similarity_max DESC);

PRAGMA user_version = 1;
