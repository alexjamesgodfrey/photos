# Local face-labeling workspace

This tool prepares person labels for the wedding gallery without changing the
public gallery. Detection, face crops, embeddings, review decisions, and
backups stay under the ignored `.media-staging/faces/` directory and are never
sent to a hosted face-recognition service.

Face similarity is only used to create conservative review groups. It never
assigns a real-world identity. A person exists only after you type their name.

## Start the labeler

The source and display derivatives must already exist under `.media-staging/`.
From the repository root:

```bash
npm run faces:setup
npm run faces:analyze
npm run faces:label
```

Then open [http://127.0.0.1:4177](http://127.0.0.1:4177). The server accepts
only that loopback host, establishes a local-only session, and requires both an
exact origin and a per-process CSRF token for every change.

`faces:analyze` is resumable. Completed photos are skipped when their verified
source, model, and pipeline inputs have not changed. To verify all inputs and
the existing workspace without processing:

```bash
npm run faces:setup -- --check
npm run faces:analyze -- --validate-only
```

If you analyze against a custom display-object directory, pass the same root
when starting the labeler:

```bash
npm run faces:analyze -- --objects-dir /absolute/private/objects
npm run faces:label -- --objects-dir /absolute/private/objects
```

## Review workflow

Start with the largest groups in **To review**:

1. Open a group and compare its face crops.
2. Use the full-photo button when a crop needs context.
3. Select and split faces that belong to someone else.
4. Ignore false detections such as shoes, flowers, or blurred objects.
5. Mark a real but unidentifiable face or group **Unknown**.
6. Type the person's unique first name and save the remaining group. Reusing
   that first name attaches later groups to the same person.
7. Select multiple groups and merge them only when they are the same person.

Every change is transactional and recorded in the local action log. **Undo**
reverses the latest unapplied action. A timestamped SQLite backup is also made
whenever the labeler starts; the newest ten are retained in
`.media-staging/faces/backups/`.

Keyboard shortcuts work when focus is not inside a form or dialog:

- `N` and `P`: next and previous group
- `L`: focus the name field
- `I`: ignore the current group
- `Escape`: close a dialog or clear the current selection

## Inspect and export

While review is incomplete, the following command validates SQLite integrity
and prints counts without writing an export:

```bash
npm run faces:export -- --allow-incomplete
```

After every group is named, unknown, or ignored, preview the final counts:

```bash
npm run faces:export
```

Only then create the authoritative JSON and SQL files:

```bash
npm run faces:export -- --apply
```

The export is written inside `.media-staging/faces/export/`. It contains people
and photo-to-person relationships only—never face crops, bounding boxes,
embeddings, source paths, or original filenames. The generated SQL is a later
production step: apply `database/002_photo_people.sql` first, review the export,
and import it only when the public gallery's person filter is implemented.

## Verification

```bash
npm run test:faces
npm test
npm run typecheck
npm run build
```

Model versions, licenses, and pinned SHA-256 digests are documented in
`MODEL_SOURCES.md`.
