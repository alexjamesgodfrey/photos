#!/usr/bin/env python3
"""Detect, embed, and conservatively cluster wedding faces entirely locally."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import sys
import time
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

import cv2
import numpy as np


PIPELINE_VERSION = "1.0.0"
SCHEMA_VERSION = 1
DETECTOR_FILENAME = "face_detection_yunet_2023mar.onnx"
DETECTOR_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
EMBEDDER_FILENAME = "face_recognition_sface_2021dec.onnx"
EMBEDDER_SHA256 = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"

DEFAULT_CONFIG: dict[str, Any] = {
    "schema_version": 1,
    "detector": {
        "max_edges": [2560, 1280, 640],
        "score_threshold": 0.70,
        "nms_threshold": 0.30,
        "top_k": 5000,
        "cross_scale_iou": 0.35,
        "minimum_face_px": 24,
        "clusterable_face_px": 40,
    },
    "embedding": {
        "dimension": 128,
        "normalization": "l2",
    },
    "clustering": {
        "auto_seed_cosine": 0.55,
        "cross_cluster_min": 0.45,
        "suggest_cosine": 0.38,
        "suggestions_per_cluster": 5,
    },
    "crop": {
        "side_px": 320,
        "margin_ratio": 0.45,
        "webp_quality": 88,
    },
}


@dataclass(frozen=True)
class PhotoInput:
    id: str
    album_position: int
    original_filename: str
    source_fingerprint: str
    source_bytes: int
    width: int
    height: int
    display_key: str
    display_sha256: str
    display_bytes: int
    scan_key: str


@dataclass
class Detection:
    row: np.ndarray
    score: float

    @property
    def box(self) -> tuple[float, float, float, float]:
        return tuple(float(value) for value in self.row[:4])


class UnionFind:
    def __init__(self, face_ids: Sequence[str], photo_ids: Sequence[str]) -> None:
        self.parent = list(range(len(face_ids)))
        self.members = [{index} for index in range(len(face_ids))]
        self.photos = [{photo_ids[index]} for index in range(len(face_ids))]
        self.sort_keys = [face_ids[index] for index in range(len(face_ids))]

    def find(self, index: int) -> int:
        while self.parent[index] != index:
            self.parent[index] = self.parent[self.parent[index]]
            index = self.parent[index]
        return index

    def merge(self, left: int, right: int) -> int:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return left_root
        if self.sort_keys[right_root] < self.sort_keys[left_root]:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root
        self.members[left_root].update(self.members[right_root])
        self.photos[left_root].update(self.photos[right_root])
        self.sort_keys[left_root] = min(
            self.sort_keys[left_root], self.sort_keys[right_root]
        )
        return left_root


def main() -> int:
    options = parse_arguments()
    paths = resolve_paths(options)
    ensure_private_workspace(
        paths["workspace"], create=not options.validate_only
    )
    validate_model(paths["detector"], DETECTOR_SHA256)
    validate_model(paths["embedder"], EMBEDDER_SHA256)

    config = json.loads(json.dumps(DEFAULT_CONFIG))
    if options.scales:
        config["detector"]["max_edges"] = options.scales
    pipeline_key = sha256_json(
        {
            "pipeline_version": PIPELINE_VERSION,
            "opencv": cv2.__version__,
            "numpy": np.__version__,
            "detector_sha256": DETECTOR_SHA256,
            "embedder_sha256": EMBEDDER_SHA256,
            "config": config,
        }
    )

    album, photos = load_and_validate_manifest(paths, pipeline_key)
    if options.validate_only:
        verified = verify_media_digests(photos, paths, event="validation_progress")
        workspace = inspect_existing_workspace(
            paths["database"], album, photos, config, pipeline_key
        )
        emit(
            "validation_complete",
            photos=len(photos),
            manifest_sha256=album["import_run"]["manifest_sha256"],
            pipeline_key=pipeline_key,
            verified_source_bytes=verified["source_bytes"],
            verified_display_bytes=verified["display_bytes"],
            workspace=workspace,
        )
        return 0

    connection = open_database(paths["database"], paths["schema"])
    try:
        initialize_workspace(connection, album, photos, config, paths, pipeline_key)
        completed_ids = {
            row["id"]
            for row in connection.execute(
                "SELECT id FROM photos WHERE scan_status='complete'"
            )
        }
        verify_media_digests(
            [photo for photo in photos if photo.id in completed_ids],
            paths,
            event="completed_media_verification_progress",
        )

        cv2.ocl.setUseOpenCL(False)
        try:
            cv2.setNumThreads(1)
        except Exception:
            pass
        detector = cv2.FaceDetectorYN.create(
            str(paths["detector"]),
            "",
            (320, 320),
            float(config["detector"]["score_threshold"]),
            float(config["detector"]["nms_threshold"]),
            int(config["detector"]["top_k"]),
            cv2.dnn.DNN_BACKEND_OPENCV,
            cv2.dnn.DNN_TARGET_CPU,
        )
        recognizer = cv2.FaceRecognizerSF.create(
            str(paths["embedder"]),
            "",
            cv2.dnn.DNN_BACKEND_OPENCV,
            cv2.dnn.DNN_TARGET_CPU,
        )

        failures = process_photos(
            connection,
            photos,
            paths,
            config,
            detector,
            recognizer,
            options.limit,
        )
        counts = scan_counts(connection)
        emit("scan_summary", **counts, failures=failures)

        if failures:
            return 1
        if counts["complete"] != len(photos):
            emit(
                "clustering_deferred",
                reason="not_all_photos_complete",
                complete=counts["complete"],
                expected=len(photos),
            )
            return 0

        cluster_faces(connection, config)
        emit("analysis_complete", **summary_counts(connection))
        return 0
    finally:
        connection.close()


def parse_arguments() -> argparse.Namespace:
    tool_dir = Path(__file__).resolve().parent
    repo_root = tool_dir.parent.parent
    parser = argparse.ArgumentParser(
        description="Analyze the verified wedding manifest locally."
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=repo_root / ".media-staging/web/manifest/photos.ndjson",
    )
    parser.add_argument(
        "--album-manifest",
        type=Path,
        default=repo_root / ".media-staging/web/manifest/album.json",
    )
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=repo_root / ".media-staging/photos-export",
    )
    parser.add_argument(
        "--objects-dir",
        type=Path,
        default=repo_root / ".media-staging/web/objects",
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=repo_root / ".media-staging/faces",
    )
    parser.add_argument("--limit", type=int)
    parser.add_argument(
        "--scales",
        type=parse_scales,
        help="Comma-separated detector max edges (default: 2560,1280,640)",
    )
    parser.add_argument("--validate-only", action="store_true")
    return parser.parse_args()


def parse_scales(value: str) -> list[int]:
    try:
        scales = [int(item.strip()) for item in value.split(",") if item.strip()]
    except ValueError as error:
        raise argparse.ArgumentTypeError("scales must be integers") from error
    if not scales or any(scale < 320 or scale > 4096 for scale in scales):
        raise argparse.ArgumentTypeError("scales must be between 320 and 4096")
    return sorted(set(scales), reverse=True)


def resolve_paths(options: argparse.Namespace) -> dict[str, Path]:
    workspace = options.workspace.resolve()
    return {
        "repo": Path(__file__).resolve().parent.parent.parent,
        "manifest": options.manifest.resolve(),
        "album_manifest": options.album_manifest.resolve(),
        "source_dir": options.source_dir.resolve(),
        "objects_dir": options.objects_dir.resolve(),
        "workspace": workspace,
        "database": workspace / "faces.sqlite3",
        "crops": workspace / "crops",
        "models": workspace / "models",
        "detector": workspace / "models" / DETECTOR_FILENAME,
        "embedder": workspace / "models" / EMBEDDER_FILENAME,
        "schema": Path(__file__).resolve().parent / "schema.sql",
    }


def ensure_private_workspace(workspace: Path, *, create: bool) -> None:
    repo_root = Path(__file__).resolve().parent.parent.parent
    allowed_root = (repo_root / ".media-staging").resolve()
    try:
        relative = workspace.relative_to(allowed_root)
    except ValueError as error:
        raise RuntimeError(
            "Workspace must be inside the repository's ignored .media-staging directory"
        ) from error
    if relative == Path("."):
        raise RuntimeError(
            "Workspace must be a child of the repository's ignored .media-staging directory"
        )
    if create:
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(workspace, 0o700)
        (workspace / "crops").mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(workspace / "crops", 0o700)


def validate_model(path: Path, expected_sha256: str) -> None:
    if not path.is_file():
        raise RuntimeError(f"Missing model {path.name}; run npm run faces:setup")
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise RuntimeError(f"{path.name} does not match its pinned SHA-256")


def load_and_validate_manifest(
    paths: dict[str, Path], pipeline_key: str
) -> tuple[dict[str, Any], list[PhotoInput]]:
    album = json.loads(paths["album_manifest"].read_text(encoding="utf-8"))
    import_run = album.get("import_run", {})
    expected_manifest_sha = import_run.get("manifest_sha256")
    actual_manifest_sha = sha256_file(paths["manifest"])
    if actual_manifest_sha != expected_manifest_sha:
        raise RuntimeError("photos.ndjson does not match album.json manifest SHA-256")
    if (
        import_run.get("status") != "completed"
        or import_run.get("complete_source_set") is not True
        or import_run.get("failed_count") != 0
    ):
        raise RuntimeError("The media manifest is not a complete successful import")

    rows: list[PhotoInput] = []
    seen_ids: set[str] = set()
    seen_positions: set[int] = set()
    source_root = paths["source_dir"]
    objects_root = paths["objects_dir"]
    with paths["manifest"].open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            raw = json.loads(line)
            photo_id = require_string(raw, "id", line_number)
            source_fingerprint = require_digest(raw, "source_fingerprint", line_number)
            if photo_id != f"p_{source_fingerprint[:32]}":
                raise RuntimeError(f"Line {line_number}: photo ID is not source-derived")
            position = require_integer(raw, "album_position", line_number, minimum=0)
            filename = require_string(raw, "original_filename", line_number)
            if Path(filename).name != filename:
                raise RuntimeError(f"Line {line_number}: invalid original filename")
            display_key = require_string(raw, "display_key", line_number)
            display_path = safe_child(objects_root, display_key)
            source_path = safe_child(source_root, filename)
            if not source_path.is_file() or not display_path.is_file():
                raise RuntimeError(f"Line {line_number}: local source or display file is missing")
            source_bytes = require_integer(raw, "source_bytes", line_number, minimum=1)
            display_bytes = require_integer(raw, "display_bytes", line_number, minimum=1)
            if source_path.stat().st_size != source_bytes:
                raise RuntimeError(f"Line {line_number}: source byte count changed")
            if display_path.stat().st_size != display_bytes:
                raise RuntimeError(f"Line {line_number}: display byte count changed")
            if photo_id in seen_ids or position in seen_positions:
                raise RuntimeError(f"Line {line_number}: duplicate photo ID or position")
            seen_ids.add(photo_id)
            seen_positions.add(position)
            scan_key = sha256_json(
                {
                    "photo_id": photo_id,
                    "source_fingerprint": source_fingerprint,
                    "pipeline_key": pipeline_key,
                }
            )
            rows.append(
                PhotoInput(
                    id=photo_id,
                    album_position=position,
                    original_filename=filename,
                    source_fingerprint=source_fingerprint,
                    source_bytes=source_bytes,
                    width=require_integer(raw, "source_width", line_number, minimum=1),
                    height=require_integer(raw, "source_height", line_number, minimum=1),
                    display_key=display_key,
                    display_sha256=require_digest(raw, "display_sha256", line_number),
                    display_bytes=display_bytes,
                    scan_key=scan_key,
                )
            )

    rows.sort(key=lambda photo: photo.album_position)
    expected_count = album.get("album", {}).get("photo_count")
    if len(rows) != expected_count or [photo.album_position for photo in rows] != list(
        range(len(rows))
    ):
        raise RuntimeError("Manifest count or album positions are incomplete")
    return album, rows


def verify_media_digests(
    photos: Sequence[PhotoInput],
    paths: dict[str, Path],
    *,
    event: str,
) -> dict[str, int]:
    source_bytes = 0
    display_bytes = 0
    for index, photo in enumerate(photos, start=1):
        source_path = safe_child(paths["source_dir"], photo.original_filename)
        display_path = safe_child(paths["objects_dir"], photo.display_key)
        if sha256_file(source_path) != photo.source_fingerprint:
            raise RuntimeError(
                f"Source SHA-256 changed for photo at album position "
                f"{photo.album_position}"
            )
        if sha256_file(display_path) != photo.display_sha256:
            raise RuntimeError(
                f"Display SHA-256 changed for photo at album position "
                f"{photo.album_position}"
            )
        source_bytes += photo.source_bytes
        display_bytes += photo.display_bytes
        if index == 1 or index % 100 == 0 or index == len(photos):
            emit(
                event,
                verified=index,
                scheduled=len(photos),
                source_bytes=source_bytes,
                display_bytes=display_bytes,
            )
    return {
        "photos": len(photos),
        "source_bytes": source_bytes,
        "display_bytes": display_bytes,
    }


def workspace_config_json(config: dict[str, Any], pipeline_key: str) -> str:
    return canonical_json(
        {
            "pipeline_key": pipeline_key,
            "opencv": cv2.__version__,
            "numpy": np.__version__,
            **config,
        }
    )


def inspect_existing_workspace(
    database: Path,
    album: dict[str, Any],
    photos: Sequence[PhotoInput],
    config: dict[str, Any],
    pipeline_key: str,
) -> dict[str, Any]:
    if not database.is_file():
        return {"exists": False}
    connection = sqlite3.connect(
        f"{database.resolve().as_uri()}?mode=ro",
        uri=True,
        timeout=5,
    )
    connection.row_factory = sqlite3.Row
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError("Existing face workspace failed SQLite integrity check")
        if connection.execute("PRAGMA foreign_key_check").fetchone():
            raise RuntimeError("Existing face workspace failed foreign-key validation")
        workspace = connection.execute(
            "SELECT * FROM workspace WHERE id=1"
        ).fetchone()
        if not workspace:
            raise RuntimeError("Existing face workspace metadata is missing")
        expected_workspace = {
            "schema_version": SCHEMA_VERSION,
            "album_id": album["album"]["id"],
            "source_manifest_sha256": album["import_run"]["manifest_sha256"],
            "detector_sha256": DETECTOR_SHA256,
            "embedder_sha256": EMBEDDER_SHA256,
            "pipeline_version": PIPELINE_VERSION,
            "config_json": workspace_config_json(config, pipeline_key),
        }
        mismatched = [
            key
            for key, expected in expected_workspace.items()
            if workspace[key] != expected
        ]
        if mismatched:
            raise RuntimeError(
                "Existing face workspace does not match current inputs: "
                + ", ".join(mismatched)
            )

        stored_photos = connection.execute(
            "SELECT id, album_position, source_fingerprint, display_sha256, "
            "scan_key, scan_status FROM photos ORDER BY album_position"
        ).fetchall()
        if len(stored_photos) != len(photos):
            raise RuntimeError("Existing face workspace photo count is stale")
        for expected, stored in zip(photos, stored_photos, strict=True):
            if (
                stored["id"] != expected.id
                or stored["album_position"] != expected.album_position
                or stored["source_fingerprint"] != expected.source_fingerprint
                or stored["display_sha256"] != expected.display_sha256
                or stored["scan_key"] != expected.scan_key
            ):
                raise RuntimeError(
                    "Existing face workspace photo metadata is stale at "
                    f"album position {expected.album_position}"
                )
        if connection.execute(
            """SELECT ph.id
             FROM photos ph
             LEFT JOIN faces f ON f.photo_id=ph.id
             WHERE ph.scan_status='complete'
             GROUP BY ph.id
             HAVING ph.face_count != count(f.id)
             LIMIT 1"""
        ).fetchone():
            raise RuntimeError("A completed photo has a stale face count")
        if connection.execute(
            """SELECT c.id
             FROM clusters c
             LEFT JOIN faces f
               ON f.id=c.representative_face_id AND f.cluster_id=c.id
             WHERE c.representative_face_id IS NULL OR f.id IS NULL
             LIMIT 1"""
        ).fetchone():
            raise RuntimeError("A cluster representative is missing or outside its cluster")
        if connection.execute(
            """SELECT id FROM faces
             WHERE embedding_f32 IS NOT NULL
               AND length(embedding_f32) != embedding_dim * 4
             LIMIT 1"""
        ).fetchone():
            raise RuntimeError("A face embedding has an invalid byte length")
        if connection.execute(
            """SELECT f.photo_id
             FROM faces f
             WHERE f.cluster_id IS NOT NULL
             GROUP BY f.cluster_id, f.photo_id
             HAVING count(*) > 1
             LIMIT 1"""
        ).fetchone():
            raise RuntimeError("A cluster contains multiple faces from one photo")
        if connection.execute(
            """SELECT s.cluster_id_a
             FROM cluster_suggestions s
             WHERE EXISTS (
               SELECT 1
               FROM cannot_links cl
               JOIN faces a ON a.id=cl.face_id_a
               JOIN faces b ON b.id=cl.face_id_b
               WHERE (
                 a.cluster_id=s.cluster_id_a
                 AND b.cluster_id=s.cluster_id_b
               ) OR (
                 a.cluster_id=s.cluster_id_b
                 AND b.cluster_id=s.cluster_id_a
               )
             )
             LIMIT 1"""
        ).fetchone():
            raise RuntimeError("A suggested merge violates a cannot-link")
        if connection.execute(
            """SELECT c.id
             FROM clusters c
             JOIN faces f ON f.cluster_id=c.id
             WHERE c.status='labeled'
               AND f.status NOT IN ('ignored', 'unknown')
               AND (
                 f.status!='labeled'
                 OR f.person_id IS NOT c.person_id
               )
             LIMIT 1"""
        ).fetchone():
            raise RuntimeError("A labeled cluster contains an inconsistent face identity")

        expected_same_photo_links = int(
            connection.execute(
                """SELECT coalesce(sum(face_count * (face_count - 1) / 2), 0)
                 FROM photos"""
            ).fetchone()[0]
        )
        actual_same_photo_links = int(
            connection.execute(
                "SELECT count(*) FROM cannot_links WHERE reason='same_photo'"
            ).fetchone()[0]
        )
        if expected_same_photo_links != actual_same_photo_links:
            raise RuntimeError("Same-photo cannot-links are incomplete")
        if connection.execute(
            """SELECT cl.face_id_a
             FROM cannot_links cl
             JOIN faces a ON a.id=cl.face_id_a
             JOIN faces b ON b.id=cl.face_id_b
             WHERE cl.reason='same_photo' AND a.photo_id!=b.photo_id
             LIMIT 1"""
        ).fetchone():
            raise RuntimeError("A same-photo cannot-link crosses two photos")

        crop_rows = connection.execute(
            "SELECT id, crop_relpath, crop_sha256 FROM faces ORDER BY id"
        ).fetchall()
        expected_crops: set[str] = set()
        crop_bytes = 0
        workspace = database.parent.resolve()
        for index, face in enumerate(crop_rows, start=1):
            relative = face["crop_relpath"]
            if (
                not isinstance(relative, str)
                or not relative.startswith("crops/")
            ):
                raise RuntimeError(f"Face {face['id']} has an invalid crop path")
            crop_path = safe_child(workspace, relative)
            if not crop_path.is_file():
                raise RuntimeError(f"Face crop is missing for {face['id']}")
            if sha256_file(crop_path) != face["crop_sha256"]:
                raise RuntimeError(f"Face crop SHA-256 changed for {face['id']}")
            expected_crops.add(relative)
            crop_bytes += crop_path.stat().st_size
            if index == 1 or index % 500 == 0 or index == len(crop_rows):
                emit(
                    "crop_validation_progress",
                    verified=index,
                    scheduled=len(crop_rows),
                    crop_bytes=crop_bytes,
                )
        actual_crops = {
            str(crop.relative_to(workspace))
            for crop in (workspace / "crops").rglob("*.webp")
            if crop.is_file()
        }
        if actual_crops != expected_crops:
            raise RuntimeError(
                "Face crop files do not exactly match the workspace database"
            )
        status_counts = {
            row["scan_status"]: int(row["count"])
            for row in connection.execute(
                "SELECT scan_status, count(*) AS count FROM photos "
                "GROUP BY scan_status"
            )
        }
        return {
            "exists": True,
            "photos": len(stored_photos),
            "complete": status_counts.get("complete", 0),
            "pending": status_counts.get("pending", 0),
            "errors": status_counts.get("error", 0),
            "faces": int(
                connection.execute("SELECT count(*) FROM faces").fetchone()[0]
            ),
            "clusters": int(
                connection.execute("SELECT count(*) FROM clusters").fetchone()[0]
            ),
            "cropBytes": crop_bytes,
        }
    finally:
        connection.close()


def open_database(database: Path, schema: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.executescript(schema.read_text(encoding="utf-8"))
    connection.execute(
        "UPDATE photos SET scan_status = 'pending', scan_error = NULL "
        "WHERE scan_status = 'processing'"
    )
    connection.commit()
    os.chmod(database, 0o600)
    return connection


def initialize_workspace(
    connection: sqlite3.Connection,
    album: dict[str, Any],
    photos: Sequence[PhotoInput],
    config: dict[str, Any],
    paths: dict[str, Path],
    pipeline_key: str,
) -> None:
    now = utc_now()
    manifest_sha = album["import_run"]["manifest_sha256"]
    album_id = album["album"]["id"]
    config_json = workspace_config_json(config, pipeline_key)
    existing = connection.execute("SELECT * FROM workspace WHERE id = 1").fetchone()
    if existing:
        changed = (
            existing["album_id"] != album_id
            or existing["source_manifest_sha256"] != manifest_sha
            or existing["detector_sha256"] != DETECTOR_SHA256
            or existing["embedder_sha256"] != EMBEDDER_SHA256
            or existing["config_json"] != config_json
        )
        if changed:
            human_work = connection.execute(
                "SELECT "
                "(SELECT count(*) FROM actions WHERE undone_at IS NULL) + "
                "(SELECT count(*) FROM people)"
            ).fetchone()[0]
            if human_work:
                raise RuntimeError(
                    "Pipeline inputs changed after labeling began; create a new workspace"
                )
            with connection:
                connection.execute("DELETE FROM cannot_links")
                connection.execute("DELETE FROM cluster_suggestions")
                connection.execute("UPDATE faces SET cluster_id = NULL")
                connection.execute("DELETE FROM clusters")
                connection.execute("DELETE FROM faces")
                connection.execute("DELETE FROM photos")
                connection.execute(
                    "UPDATE workspace SET album_id=?, source_manifest_sha256=?, "
                    "detector_sha256=?, embedder_sha256=?, pipeline_version=?, "
                    "config_json=?, cluster_run_key=NULL, clustered_at=NULL, updated_at=? "
                    "WHERE id=1",
                    (
                        album_id,
                        manifest_sha,
                        DETECTOR_SHA256,
                        EMBEDDER_SHA256,
                        PIPELINE_VERSION,
                        config_json,
                        now,
                    ),
                )
    else:
        connection.execute(
            "INSERT INTO workspace "
            "(id, schema_version, album_id, source_manifest_sha256, detector_sha256, "
            "embedder_sha256, pipeline_version, config_json, created_at, updated_at) "
            "VALUES (1,?,?,?,?,?,?,?,?,?)",
            (
                SCHEMA_VERSION,
                album_id,
                manifest_sha,
                DETECTOR_SHA256,
                EMBEDDER_SHA256,
                PIPELINE_VERSION,
                config_json,
                now,
                now,
            ),
        )

    with connection:
        for photo in photos:
            display_relpath = str(Path("web/objects") / photo.display_key)
            connection.execute(
                "INSERT INTO photos "
                "(id, album_position, source_fingerprint, display_relpath, display_sha256, "
                "width, height, scan_key, scan_status) VALUES (?,?,?,?,?,?,?,?, 'pending') "
                "ON CONFLICT(id) DO UPDATE SET "
                "album_position=excluded.album_position, "
                "source_fingerprint=excluded.source_fingerprint, "
                "display_relpath=excluded.display_relpath, "
                "display_sha256=excluded.display_sha256, width=excluded.width, "
                "height=excluded.height, "
                "scan_status=CASE WHEN photos.scan_key=excluded.scan_key "
                "THEN photos.scan_status ELSE 'pending' END, "
                "face_count=CASE WHEN photos.scan_key=excluded.scan_key "
                "THEN photos.face_count ELSE 0 END, "
                "scan_error=CASE WHEN photos.scan_key=excluded.scan_key "
                "THEN photos.scan_error ELSE NULL END, "
                "processed_at=CASE WHEN photos.scan_key=excluded.scan_key "
                "THEN photos.processed_at ELSE NULL END, "
                "scan_key=excluded.scan_key",
                (
                    photo.id,
                    photo.album_position,
                    photo.source_fingerprint,
                    display_relpath,
                    photo.display_sha256,
                    photo.width,
                    photo.height,
                    photo.scan_key,
                ),
            )
    paths["crops"].mkdir(parents=True, exist_ok=True, mode=0o700)


def process_photos(
    connection: sqlite3.Connection,
    photos: Sequence[PhotoInput],
    paths: dict[str, Path],
    config: dict[str, Any],
    detector: Any,
    recognizer: Any,
    limit: int | None,
) -> int:
    by_id = {photo.id: photo for photo in photos}
    query = (
        "SELECT id FROM photos WHERE scan_status IN ('pending','error') "
        "ORDER BY album_position"
    )
    pending = [row["id"] for row in connection.execute(query)]
    if limit is not None:
        if limit < 1:
            raise RuntimeError("--limit must be positive")
        pending = pending[:limit]
    failures = 0
    started = time.monotonic()
    for offset, photo_id in enumerate(pending, start=1):
        photo = by_id[photo_id]
        with connection:
            connection.execute(
                "UPDATE photos SET scan_status='processing', attempt_count=attempt_count+1, "
                "scan_error=NULL WHERE id=?",
                (photo_id,),
            )
        try:
            face_rows = analyze_photo(photo, paths, config, detector, recognizer)
            persist_photo(connection, photo, face_rows)
        except Exception as error:
            failures += 1
            with connection:
                connection.execute(
                    "UPDATE photos SET scan_status='error', scan_error=? WHERE id=?",
                    (str(error)[:1000], photo_id),
                )
            emit(
                "photo_error",
                photo_id=photo_id,
                album_position=photo.album_position,
                error=str(error),
            )
            traceback.print_exc(file=sys.stderr)
        if offset == 1 or offset % 10 == 0 or offset == len(pending):
            elapsed = time.monotonic() - started
            emit(
                "scan_progress",
                processed=offset,
                scheduled=len(pending),
                failures=failures,
                elapsed_seconds=round(elapsed, 2),
                photos_per_minute=round(offset / max(elapsed, 0.001) * 60, 2),
            )
    return failures


def analyze_photo(
    photo: PhotoInput,
    paths: dict[str, Path],
    config: dict[str, Any],
    detector: Any,
    recognizer: Any,
) -> list[dict[str, Any]]:
    source_path = safe_child(paths["source_dir"], photo.original_filename)
    if sha256_file(source_path) != photo.source_fingerprint:
        raise RuntimeError("Source SHA-256 changed")
    display_path = safe_child(paths["objects_dir"], photo.display_key)
    if sha256_file(display_path) != photo.display_sha256:
        raise RuntimeError("Display SHA-256 changed")

    encoded = np.fromfile(source_path, dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("OpenCV could not decode the source JPEG")
    height, width = image.shape[:2]
    if width != photo.width or height != photo.height:
        raise RuntimeError("Decoded source dimensions changed")

    detections: list[Detection] = []
    used_sizes: set[tuple[int, int]] = set()
    for max_edge in config["detector"]["max_edges"]:
        scale = min(1.0, float(max_edge) / max(width, height))
        scaled_width = max(1, int(round(width * scale)))
        scaled_height = max(1, int(round(height * scale)))
        size = (scaled_width, scaled_height)
        if size in used_sizes:
            continue
        used_sizes.add(size)
        scaled = (
            image
            if scale == 1.0
            else cv2.resize(image, size, interpolation=cv2.INTER_AREA)
        )
        detector.setInputSize(size)
        _, found = detector.detect(scaled)
        if found is None:
            continue
        for face in found:
            mapped = np.asarray(face, dtype=np.float32).copy()
            mapped[:14] /= scale
            mapped[0] = max(0.0, mapped[0])
            mapped[1] = max(0.0, mapped[1])
            mapped[2] = min(float(width) - mapped[0], mapped[2])
            mapped[3] = min(float(height) - mapped[1], mapped[3])
            if mapped[2] <= 0 or mapped[3] <= 0:
                continue
            detections.append(Detection(mapped, float(mapped[14])))

    detections = cross_scale_nms(
        detections, float(config["detector"]["cross_scale_iou"])
    )
    minimum_face = int(config["detector"]["minimum_face_px"])
    detections = [
        detection
        for detection in detections
        if min(detection.row[2], detection.row[3]) >= minimum_face
    ]
    detections.sort(
        key=lambda detection: (
            round(float(detection.row[1]), 4),
            round(float(detection.row[0]), 4),
            round(float(detection.row[1] + detection.row[3]), 4),
            round(float(detection.row[0] + detection.row[2]), 4),
            -round(detection.score, 6),
        )
    )

    result: list[dict[str, Any]] = []
    for ordinal, detection in enumerate(detections):
        normalized_box = [
            clamp(float(detection.row[0]) / width),
            clamp(float(detection.row[1]) / height),
            clamp(float(detection.row[2]) / width, minimum=1 / width),
            clamp(float(detection.row[3]) / height, minimum=1 / height),
        ]
        landmarks: list[float] = []
        for index in range(4, 14, 2):
            landmarks.extend(
                [
                    clamp(float(detection.row[index]) / width),
                    clamp(float(detection.row[index + 1]) / height),
                ]
            )
        identity_payload = {
            "scan_key": photo.scan_key,
            "ordinal": ordinal,
            "bbox": [round(value, 7) for value in normalized_box],
            "landmarks": [round(value, 7) for value in landmarks],
        }
        face_id = f"f_{sha256_json(identity_payload)[:32]}"
        crop_bytes = create_face_crop(image, detection.row, config)
        crop_sha = hashlib.sha256(crop_bytes).hexdigest()
        crop_relpath = str(Path("crops") / face_id[:4] / f"{face_id}.webp")
        write_private_atomic(paths["workspace"] / crop_relpath, crop_bytes)

        embedding: np.ndarray | None = None
        try:
            aligned = recognizer.alignCrop(image, detection.row.astype(np.float32))
            feature = np.asarray(recognizer.feature(aligned), dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(feature))
            if math.isfinite(norm) and norm > 1e-12:
                embedding = np.ascontiguousarray(feature / norm, dtype=np.float32)
        except cv2.error:
            embedding = None

        face_width = max(1, int(round(float(detection.row[2]))))
        face_height = max(1, int(round(float(detection.row[3]))))
        minimum_dimension = min(face_width, face_height)
        quality = (
            "clusterable"
            if embedding is not None
            and minimum_dimension >= int(config["detector"]["clusterable_face_px"])
            else "manual_only"
        )
        quality_score = min(
            1.0,
            max(
                0.0,
                detection.score
                * min(1.0, minimum_dimension / 160.0),
            ),
        )
        result.append(
            {
                "id": face_id,
                "photo_id": photo.id,
                "ordinal": ordinal,
                "bbox": normalized_box,
                "landmarks_json": canonical_json(landmarks),
                "score": detection.score,
                "width_px": face_width,
                "height_px": face_height,
                "quality": quality,
                "quality_score": quality_score,
                "embedding": None if embedding is None else embedding.tobytes(),
                "embedding_dim": None if embedding is None else int(embedding.size),
                "crop_relpath": crop_relpath,
                "crop_sha256": crop_sha,
            }
        )
    return result


def cross_scale_nms(detections: Sequence[Detection], threshold: float) -> list[Detection]:
    ordered = sorted(
        detections,
        key=lambda detection: (
            -round(detection.score, 6),
            -round(detection.row[2] * detection.row[3], 4),
            round(detection.row[1], 4),
            round(detection.row[0], 4),
        ),
    )
    kept: list[Detection] = []
    for detection in ordered:
        if all(box_iou(detection.box, existing.box) < threshold for existing in kept):
            kept.append(detection)
    return kept


def box_iou(
    left: tuple[float, float, float, float],
    right: tuple[float, float, float, float],
) -> float:
    left_x, left_y, left_w, left_h = left
    right_x, right_y, right_w, right_h = right
    intersection_w = max(
        0.0, min(left_x + left_w, right_x + right_w) - max(left_x, right_x)
    )
    intersection_h = max(
        0.0, min(left_y + left_h, right_y + right_h) - max(left_y, right_y)
    )
    intersection = intersection_w * intersection_h
    union = left_w * left_h + right_w * right_h - intersection
    return 0.0 if union <= 0 else intersection / union


def create_face_crop(
    image: np.ndarray, face: np.ndarray, config: dict[str, Any]
) -> bytes:
    image_height, image_width = image.shape[:2]
    x, y, width, height = (float(value) for value in face[:4])
    margin = float(config["crop"]["margin_ratio"])
    side = max(width, height) * (1.0 + margin * 2.0)
    center_x = x + width / 2.0
    center_y = y + height * 0.48
    left = max(0, int(math.floor(center_x - side / 2.0)))
    top = max(0, int(math.floor(center_y - side / 2.0)))
    right = min(image_width, int(math.ceil(center_x + side / 2.0)))
    bottom = min(image_height, int(math.ceil(center_y + side / 2.0)))
    crop = image[top:bottom, left:right]
    if crop.size == 0:
        raise RuntimeError("Detected face produced an empty crop")
    output_side = int(config["crop"]["side_px"])
    interpolation = (
        cv2.INTER_AREA
        if max(crop.shape[:2]) > output_side
        else cv2.INTER_CUBIC
    )
    resized = cv2.resize(crop, (output_side, output_side), interpolation=interpolation)
    success, encoded = cv2.imencode(
        ".webp",
        resized,
        [cv2.IMWRITE_WEBP_QUALITY, int(config["crop"]["webp_quality"])],
    )
    if not success:
        raise RuntimeError("Unable to encode metadata-free face crop")
    return bytes(encoded)


def persist_photo(
    connection: sqlite3.Connection,
    photo: PhotoInput,
    face_rows: Sequence[dict[str, Any]],
) -> None:
    now = utc_now()
    with connection:
        existing_human_work = connection.execute(
            "SELECT count(*) FROM faces WHERE photo_id=? "
            "AND (status != 'unreviewed' OR person_id IS NOT NULL)",
            (photo.id,),
        ).fetchone()[0]
        if existing_human_work:
            raise RuntimeError("Refusing to replace a photo after human labeling")
        connection.execute("DELETE FROM faces WHERE photo_id=?", (photo.id,))
        for face in face_rows:
            box = face["bbox"]
            connection.execute(
                "INSERT INTO faces "
                "(id, photo_id, ordinal, bbox_x, bbox_y, bbox_width, bbox_height, "
                "landmarks_json, detection_score, width_px, height_px, quality, "
                "quality_score, embedding_f32, embedding_dim, crop_relpath, "
                "crop_sha256, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    face["id"],
                    photo.id,
                    face["ordinal"],
                    box[0],
                    box[1],
                    box[2],
                    box[3],
                    face["landmarks_json"],
                    face["score"],
                    face["width_px"],
                    face["height_px"],
                    face["quality"],
                    face["quality_score"],
                    face["embedding"],
                    face["embedding_dim"],
                    face["crop_relpath"],
                    face["crop_sha256"],
                    now,
                    now,
                ),
            )
        for left_index, left in enumerate(face_rows):
            for right in face_rows[left_index + 1 :]:
                face_a, face_b = sorted((left["id"], right["id"]))
                connection.execute(
                    "INSERT OR IGNORE INTO cannot_links "
                    "(face_id_a, face_id_b, reason, created_at) VALUES (?,?, 'same_photo', ?)",
                    (face_a, face_b, now),
                )
        connection.execute(
            "UPDATE photos SET scan_status='complete', face_count=?, "
            "scan_error=NULL, processed_at=? WHERE id=?",
            (len(face_rows), now, photo.id),
        )


def cluster_faces(connection: sqlite3.Connection, config: dict[str, Any]) -> None:
    active_actions = connection.execute(
        "SELECT count(*) FROM actions WHERE undone_at IS NULL"
    ).fetchone()[0]
    labeled_faces = connection.execute(
        "SELECT count(*) FROM faces WHERE status != 'unreviewed' OR person_id IS NOT NULL"
    ).fetchone()[0]
    if active_actions or labeled_faces:
        emit("clustering_preserved", reason="human_review_exists")
        return

    rows = connection.execute(
        "SELECT id, photo_id, quality, quality_score, embedding_f32, embedding_dim "
        "FROM faces ORDER BY id"
    ).fetchall()
    clusterable = [
        row
        for row in rows
        if row["quality"] == "clusterable"
        and row["embedding_f32"] is not None
        and row["embedding_dim"] is not None
    ]
    embedding_hasher = hashlib.sha256()
    for row in rows:
        embedding_hasher.update(row["id"].encode("utf-8"))
        if row["embedding_f32"]:
            embedding_hasher.update(row["embedding_f32"])
    cluster_run_key = sha256_json(
        {
            "embedding_set": embedding_hasher.hexdigest(),
            "clustering": config["clustering"],
            "pipeline_version": PIPELINE_VERSION,
        }
    )
    workspace = connection.execute("SELECT cluster_run_key FROM workspace WHERE id=1").fetchone()
    existing_clusters = connection.execute("SELECT count(*) FROM clusters").fetchone()[0]
    if workspace["cluster_run_key"] == cluster_run_key and existing_clusters:
        emit("clustering_skipped", reason="matching_cluster_run_key")
        return

    components: list[list[str]] = []
    similarity: np.ndarray | None = None
    clusterable_ids: list[str] = []
    clusterable_photos: list[str] = []
    if clusterable:
        clusterable_ids = [row["id"] for row in clusterable]
        clusterable_photos = [row["photo_id"] for row in clusterable]
        embeddings = np.vstack(
            [
                np.frombuffer(
                    row["embedding_f32"], dtype=np.float32, count=row["embedding_dim"]
                )
                for row in clusterable
            ]
        )
        similarity = np.clip(embeddings @ embeddings.T, -1.0, 1.0)
        union_find = UnionFind(clusterable_ids, clusterable_photos)
        seed = float(config["clustering"]["auto_seed_cosine"])
        floor = float(config["clustering"]["cross_cluster_min"])
        candidate_pairs = np.argwhere(np.triu(similarity >= seed, k=1))
        candidates = sorted(
            (
                (
                    -round(float(similarity[left, right]), 6),
                    clusterable_ids[left],
                    clusterable_ids[right],
                    int(left),
                    int(right),
                )
                for left, right in candidate_pairs
            )
        )
        for _, _, _, left, right in candidates:
            left_root = union_find.find(left)
            right_root = union_find.find(right)
            if left_root == right_root:
                continue
            if union_find.photos[left_root].intersection(union_find.photos[right_root]):
                continue
            left_members = sorted(union_find.members[left_root])
            right_members = sorted(union_find.members[right_root])
            cross_minimum = round(
                float(similarity[np.ix_(left_members, right_members)].min()), 6
            )
            if cross_minimum < floor:
                continue
            union_find.merge(left_root, right_root)
        grouped: dict[int, list[str]] = {}
        for index, face_id in enumerate(clusterable_ids):
            grouped.setdefault(union_find.find(index), []).append(face_id)
        components.extend(
            sorted(
                (sorted(face_ids) for face_ids in grouped.values()),
                key=lambda face_ids: face_ids[0],
            )
        )

    clustered_ids = {face_id for component in components for face_id in component}
    components.extend([[row["id"]] for row in rows if row["id"] not in clustered_ids])
    components.sort(key=lambda face_ids: face_ids[0])

    now = utc_now()
    face_quality = {row["id"]: float(row["quality_score"]) for row in rows}
    with connection:
        connection.execute("DELETE FROM cluster_suggestions")
        connection.execute("UPDATE faces SET cluster_id=NULL")
        connection.execute("DELETE FROM clusters")
        face_to_cluster: dict[str, str] = {}
        for face_ids in components:
            cluster_id = f"c_{hashlib.sha256(chr(10).join(face_ids).encode()).hexdigest()[:24]}"
            representative = sorted(
                face_ids, key=lambda face_id: (-face_quality[face_id], face_id)
            )[0]
            connection.execute(
                "INSERT INTO clusters "
                "(id, origin, status, representative_face_id, created_at, updated_at) "
                "VALUES (?, 'automatic', 'unreviewed', ?, ?, ?)",
                (cluster_id, representative, now, now),
            )
            for face_id in face_ids:
                face_to_cluster[face_id] = cluster_id
                connection.execute(
                    "UPDATE faces SET cluster_id=?, updated_at=? WHERE id=?",
                    (cluster_id, now, face_id),
                )

        if similarity is not None and len(clusterable_ids) > 1:
            insert_cluster_suggestions(
                connection,
                clusterable_ids,
                face_to_cluster,
                similarity,
                config,
                now,
            )
        connection.execute(
            "UPDATE workspace SET cluster_run_key=?, clustered_at=?, updated_at=? WHERE id=1",
            (cluster_run_key, now, now),
        )


def insert_cluster_suggestions(
    connection: sqlite3.Connection,
    face_ids: Sequence[str],
    face_to_cluster: dict[str, str],
    similarity: np.ndarray,
    config: dict[str, Any],
    now: str,
) -> None:
    cluster_indices: dict[str, list[int]] = {}
    for index, face_id in enumerate(face_ids):
        cluster_indices.setdefault(face_to_cluster[face_id], []).append(index)
    cluster_ids = sorted(cluster_indices)
    blocked_pairs: set[tuple[str, str]] = set()
    for row in connection.execute(
        "SELECT face_id_a, face_id_b FROM cannot_links"
    ):
        left_cluster = face_to_cluster.get(row["face_id_a"])
        right_cluster = face_to_cluster.get(row["face_id_b"])
        if (
            left_cluster
            and right_cluster
            and left_cluster != right_cluster
        ):
            blocked_pairs.add(tuple(sorted((left_cluster, right_cluster))))
    threshold = float(config["clustering"]["suggest_cosine"])
    per_cluster = int(config["clustering"]["suggestions_per_cluster"])
    suggestions: list[tuple[float, str, str, float, float]] = []
    for left_position, left_cluster in enumerate(cluster_ids):
        left_indices = cluster_indices[left_cluster]
        for right_cluster in cluster_ids[left_position + 1 :]:
            if (left_cluster, right_cluster) in blocked_pairs:
                continue
            values = similarity[
                np.ix_(left_indices, cluster_indices[right_cluster])
            ].reshape(-1)
            maximum = float(values.max())
            if maximum < threshold:
                continue
            suggestions.append(
                (
                    maximum,
                    left_cluster,
                    right_cluster,
                    float(np.median(values)),
                    float(values.min()),
                )
            )
    selected: set[tuple[str, str]] = set()
    by_cluster: dict[str, list[tuple[float, str, str, float, float]]] = {}
    for suggestion in suggestions:
        by_cluster.setdefault(suggestion[1], []).append(suggestion)
        by_cluster.setdefault(suggestion[2], []).append(suggestion)
    for cluster_id, entries in by_cluster.items():
        del cluster_id
        for entry in sorted(entries, key=lambda item: (-round(item[0], 6), item[1], item[2]))[
            :per_cluster
        ]:
            selected.add((entry[1], entry[2]))
    for maximum, left, right, median, minimum in suggestions:
        if (left, right) not in selected:
            continue
        connection.execute(
            "INSERT INTO cluster_suggestions "
            "(cluster_id_a, cluster_id_b, similarity_max, similarity_median, "
            "similarity_min, created_at) VALUES (?,?,?,?,?,?)",
            (left, right, maximum, median, minimum, now),
        )


def scan_counts(connection: sqlite3.Connection) -> dict[str, int]:
    result: dict[str, int] = {}
    for status in ("pending", "processing", "complete", "error"):
        result[status] = int(
            connection.execute(
                "SELECT count(*) FROM photos WHERE scan_status=?", (status,)
            ).fetchone()[0]
        )
    return result


def summary_counts(connection: sqlite3.Connection) -> dict[str, int]:
    return {
        "photos": int(connection.execute("SELECT count(*) FROM photos").fetchone()[0]),
        "faces": int(connection.execute("SELECT count(*) FROM faces").fetchone()[0]),
        "clusterable_faces": int(
            connection.execute(
                "SELECT count(*) FROM faces WHERE quality='clusterable'"
            ).fetchone()[0]
        ),
        "manual_only_faces": int(
            connection.execute(
                "SELECT count(*) FROM faces WHERE quality='manual_only'"
            ).fetchone()[0]
        ),
        "clusters": int(connection.execute("SELECT count(*) FROM clusters").fetchone()[0]),
        "suggestions": int(
            connection.execute("SELECT count(*) FROM cluster_suggestions").fetchone()[0]
        ),
    }


def require_string(raw: dict[str, Any], key: str, line: int) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"Line {line}: {key} must be a non-empty string")
    return value


def require_digest(raw: dict[str, Any], key: str, line: int) -> str:
    value = require_string(raw, key, line)
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise RuntimeError(f"Line {line}: {key} must be a lowercase SHA-256")
    return value


def require_integer(
    raw: dict[str, Any], key: str, line: int, minimum: int
) -> int:
    value = raw.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise RuntimeError(f"Line {line}: {key} must be an integer >= {minimum}")
    return value


def safe_child(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise RuntimeError("Manifest path escaped its allowlisted directory") from error
    return candidate


def sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return min(maximum, max(minimum, value))


def write_private_atomic(destination: Path, payload: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination.parent, 0o700)
    temporary = destination.with_name(f".{destination.name}.partial-{os.getpid()}")
    try:
        with temporary.open("xb") as handle:
            os.chmod(temporary, 0o600)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        os.chmod(destination, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def emit(event: str, **values: Any) -> None:
    print(canonical_json({"event": event, "time": utc_now(), **values}), flush=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        emit("interrupted")
        raise SystemExit(130)
    except Exception as error:
        emit("fatal_error", error=str(error))
        traceback.print_exc(file=sys.stderr)
        raise SystemExit(1)
