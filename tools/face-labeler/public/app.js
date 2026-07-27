"use strict";

(() => {
  const csrfToken =
    document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";

  const state = {
    filter: "unreviewed",
    query: "",
    clusters: [],
    summary: {},
    activeClusterId: null,
    activeDetail: null,
    batchLabelProposal: null,
    selectedClusterIds: new Set(),
    selectedFaceIds: new Set(),
    renderedClusterCount: 0,
    bootstrapRequest: 0,
    detailRequest: 0,
    toastTimer: null,
    confirmResolve: null,
  };

  const elements = {
    progressPercent: document.querySelector("#progress-percent"),
    progressCaption: document.querySelector("#progress-caption"),
    progressTrack: document.querySelector(".progress-track"),
    progressBar: document.querySelector("#progress-bar"),
    statLabeled: document.querySelector("#stat-labeled"),
    statUnknown: document.querySelector("#stat-unknown"),
    statRemaining: document.querySelector("#stat-remaining"),
    statFaces: document.querySelector("#stat-faces"),
    filterCounts: {
      unreviewed: document.querySelector("#filter-count-unreviewed"),
      labeled: document.querySelector("#filter-count-labeled"),
      unknown: document.querySelector("#filter-count-unknown"),
      ignored: document.querySelector("#filter-count-ignored"),
    },
    filterButtons: [...document.querySelectorAll(".filter-chip")],
    clusterSearch: document.querySelector("#cluster-search"),
    clearSearch: document.querySelector("#clear-search"),
    refreshButton: document.querySelector("#refresh-button"),
    clusterList: document.querySelector("#cluster-list"),
    clusterListCount: document.querySelector("#cluster-list-count"),
    mergeTray: document.querySelector("#merge-tray"),
    mergeCount: document.querySelector("#merge-count"),
    mergeButton: document.querySelector("#merge-button"),
    clearClusterSelection: document.querySelector("#clear-cluster-selection"),
    detailEmpty: document.querySelector("#detail-empty"),
    detailContent: document.querySelector("#detail-content"),
    detailPanel: document.querySelector("#cluster-detail"),
    activeStatus: document.querySelector("#active-status"),
    activePosition: document.querySelector("#active-cluster-position"),
    activeHeading: document.querySelector("#active-cluster-heading"),
    activeSummary: document.querySelector("#active-cluster-summary"),
    previousCluster: document.querySelector("#previous-cluster"),
    nextCluster: document.querySelector("#next-cluster"),
    labelForm: document.querySelector("#label-form"),
    personName: document.querySelector("#person-name"),
    saveLabel: document.querySelector("#save-label"),
    unknownCluster: document.querySelector("#unknown-cluster"),
    ignoreCluster: document.querySelector("#ignore-cluster"),
    recoverCluster: document.querySelector("#recover-cluster"),
    suggestionsPanel: document.querySelector("#suggestions-panel"),
    suggestionsStrip: document.querySelector("#suggestions-strip"),
    batchLabelAction: document.querySelector("#batch-label-action"),
    batchLabelHint: document.querySelector("#batch-label-hint"),
    batchLabelButton: document.querySelector("#batch-label-button"),
    faceGrid: document.querySelector("#face-grid"),
    faceSelectionCount: document.querySelector("#face-selection-count"),
    clearFaceSelection: document.querySelector("#clear-face-selection"),
    splitButton: document.querySelector("#split-button"),
    undoButton: document.querySelector("#undo-button"),
    exportButton: document.querySelector("#export-button"),
    confirmDialog: document.querySelector("#confirm-dialog"),
    confirmTitle: document.querySelector("#confirm-title"),
    confirmMessage: document.querySelector("#confirm-message"),
    confirmAction: document.querySelector("#confirm-action"),
    photoDialog: document.querySelector("#photo-dialog"),
    closePhoto: document.querySelector("#close-photo"),
    photoStage: document.querySelector("#photo-stage"),
    fullPhoto: document.querySelector("#full-photo"),
    exportDialog: document.querySelector("#export-dialog"),
    closeExport: document.querySelector("#close-export"),
    exportSummary: document.querySelector("#export-summary"),
    exportPeopleList: document.querySelector("#export-people-list"),
    toastRegion: document.querySelector("#toast-region"),
    politeStatus: document.querySelector("#polite-status"),
    assertiveStatus: document.querySelector("#assertive-status"),
  };

  const STATUS_LABELS = {
    unreviewed: "To review",
    labeled: "Named",
    unknown: "Unknown",
    ignored: "Ignored",
  };

  const numberFormatter = new Intl.NumberFormat();
  const CLUSTER_RENDER_BATCH = 80;

  function asNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatNumber(value) {
    return numberFormatter.format(asNumber(value));
  }

  function countValue(value) {
    return Array.isArray(value) ? value.length : asNumber(value);
  }

  function pluralize(value, singular, plural = `${singular}s`) {
    return `${formatNumber(value)} ${asNumber(value) === 1 ? singular : plural}`;
  }

  function icon(name) {
    return `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
  }

  function safeStatus(value, fallback = "unreviewed") {
    return ["unreviewed", "labeled", "unknown", "ignored"].includes(value)
      ? value
      : fallback;
  }

  function normalizeCluster(raw = {}) {
    const displayName = String(
      raw.displayName ?? raw.personName ?? raw.label ?? raw.name ?? "",
    ).trim();
    const status = safeStatus(
      String(
        raw.status ??
          (raw.ignored
            ? "ignored"
            : raw.unknown
              ? "unknown"
              : displayName
                ? "labeled"
                : "unreviewed"),
      ).toLowerCase(),
    );
    const faces = Array.isArray(raw.faces) ? raw.faces : [];

    return {
      id: String(raw.id ?? raw.clusterId ?? ""),
      status,
      personId: raw.personId ?? null,
      displayName,
      faceCount: asNumber(raw.faceCount ?? raw.face_count, faces.length),
      photoCount: asNumber(raw.photoCount ?? raw.photo_count, faces.length),
      representativeFaceId:
        raw.representativeFaceId ??
        raw.coverFaceId ??
        raw.thumbnailFaceId ??
        faces[0]?.id ??
        null,
      confidence: asNumber(raw.confidence, NaN),
      reviewedAt: raw.reviewedAt ?? null,
      faces,
    };
  }

  function normalizeFace(raw = {}) {
    const status = safeStatus(
      String(
        raw.status ??
          (raw.ignored ? "ignored" : raw.unknown ? "unknown" : "unreviewed"),
      ).toLowerCase(),
    );

    return {
      id: String(raw.id ?? raw.faceId ?? ""),
      photoId:
        raw.photoId === null || raw.photoId === undefined
          ? null
          : String(raw.photoId),
      albumPosition: asNumber(raw.albumPosition, NaN),
      confidence: asNumber(raw.confidence, NaN),
      quality:
        typeof raw.quality === "string" ? raw.quality : String(raw.quality ?? ""),
      qualityScore: asNumber(raw.qualityScore ?? raw.quality_score, NaN),
      status,
      ignored: status === "ignored" || Boolean(raw.ignored),
      unknown: status === "unknown" || Boolean(raw.unknown),
      personId: raw.personId ?? null,
      clusterId: raw.clusterId ?? null,
      bbox: raw.bbox ?? null,
    };
  }

  function normalizeSuggestion(raw = {}) {
    const similarity = raw.similarity ?? {};
    return {
      clusterId: String(raw.clusterId ?? raw.id ?? ""),
      personId: raw.personId ?? null,
      displayName: String(
        raw.displayName ?? raw.personName ?? raw.label ?? "",
      ).trim(),
      status: safeStatus(String(raw.status ?? "unreviewed").toLowerCase()),
      representativeFaceId:
        raw.representativeFaceId ?? raw.coverFaceId ?? null,
      similarity: {
        max: asNumber(similarity.max ?? raw.similarityMax, NaN),
        median: asNumber(similarity.median ?? raw.similarityMedian, NaN),
        min: asNumber(similarity.min ?? raw.similarityMin, NaN),
      },
    };
  }

  function normalizeDetail(payload = {}) {
    const source = payload.cluster ?? payload;
    const cluster = normalizeCluster(source);
    const faces = Array.isArray(payload.faces)
      ? payload.faces
      : Array.isArray(source.faces)
        ? source.faces
        : [];

    cluster.faces = faces.map(normalizeFace).filter((face) => face.id);
    const suggestions = Array.isArray(payload.suggestions)
      ? payload.suggestions
      : Array.isArray(source.suggestions)
        ? source.suggestions
        : [];
    cluster.suggestions = suggestions
      .map(normalizeSuggestion)
      .filter(
        (suggestion) =>
          suggestion.clusterId && suggestion.clusterId !== cluster.id,
      );
    if (!cluster.faceCount) cluster.faceCount = cluster.faces.length;
    if (!cluster.photoCount) {
      cluster.photoCount = new Set(
        cluster.faces.map((face) => face.photoId).filter(Boolean),
      ).size;
    }
    return cluster;
  }

  async function api(path, options = {}) {
    const isMutation =
      options.method && String(options.method).toUpperCase() !== "GET";
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");

    if (isMutation) {
      if (!csrfToken || csrfToken === "__FACE_LABELER_CSRF__") {
        throw new Error(
          "The local labeler did not receive its security token. Restart the labeler and refresh this page.",
        );
      }
      headers.set("X-Face-Labeler-CSRF", csrfToken);
      if (options.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
    }

    const response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.error ||
        data?.message ||
        `Request failed (${response.status})`;
      throw new Error(String(message));
    }

    return data;
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.classList.toggle("is-busy", busy);
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
  }

  function announce(message, assertive = false) {
    const target = assertive ? elements.assertiveStatus : elements.politeStatus;
    target.textContent = "";
    window.setTimeout(() => {
      target.textContent = message;
    }, 20);
  }

  function toast(message, tone = "success") {
    const item = document.createElement("div");
    item.className = "toast";
    item.dataset.tone = tone;
    item.setAttribute("role", tone === "error" ? "alert" : "status");

    const mark = document.createElement("span");
    mark.className = "toast-mark";
    mark.textContent = tone === "error" ? "!" : tone === "info" ? "i" : "✓";
    mark.setAttribute("aria-hidden", "true");

    const copy = document.createElement("p");
    copy.textContent = message;

    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss message");
    close.innerHTML = icon("close");
    close.addEventListener("click", () => item.remove());

    item.append(mark, copy, close);
    elements.toastRegion.replaceChildren(item);

    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => item.remove(), 5200);
  }

  function showError(error, fallback = "Something went wrong.") {
    const message =
      error instanceof Error && error.message ? error.message : fallback;
    toast(message, "error");
    announce(message, true);
  }

  function renderClusterSkeletons() {
    elements.clusterList.setAttribute("aria-busy", "true");
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 5; index += 1) {
      const card = document.createElement("div");
      card.className = "skeleton-card";
      card.setAttribute("aria-hidden", "true");
      card.innerHTML =
        '<div class="skeleton-lines"><span></span><span></span></div>';
      fragment.append(card);
    }
    elements.clusterList.replaceChildren(fragment);
    elements.clusterListCount.textContent = "Loading groups…";
  }

  function renderSummary() {
    const summary = state.summary;
    const labeled = asNumber(summary.labeledClusters);
    const unknown = asNumber(summary.unknownClusters);
    const ignored = asNumber(summary.ignoredClusters);
    const unreviewed = asNumber(summary.unreviewedClusters);
    const total = labeled + unknown + ignored + unreviewed;
    const completed = labeled + unknown + ignored;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    elements.progressPercent.textContent = `${progress}%`;
    elements.progressCaption.textContent =
      total > 0
        ? `${pluralize(completed, "group")} reviewed out of ${formatNumber(total)}`
        : "No face groups are ready yet";
    elements.progressBar.style.width = `${progress}%`;
    elements.progressTrack.setAttribute("aria-valuenow", String(progress));
    elements.progressTrack.setAttribute(
      "aria-valuetext",
      `${progress}% complete, ${completed} of ${total} groups reviewed`,
    );

    elements.statLabeled.textContent = formatNumber(labeled);
    elements.statUnknown.textContent = formatNumber(unknown);
    elements.statRemaining.textContent = formatNumber(
      summary.remainingFaces ?? unreviewed,
    );
    elements.statFaces.textContent = formatNumber(summary.totalFaces);

    elements.filterCounts.unreviewed.textContent = formatNumber(unreviewed);
    elements.filterCounts.labeled.textContent = formatNumber(labeled);
    elements.filterCounts.unknown.textContent = formatNumber(unknown);
    elements.filterCounts.ignored.textContent = formatNumber(ignored);
  }

  function createClusterCard(cluster, index) {
    const card = document.createElement("article");
    card.className = "cluster-card";
    card.dataset.clusterId = cluster.id;
    card.classList.toggle("is-active", cluster.id === state.activeClusterId);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "cluster-open";
    open.setAttribute(
      "aria-label",
      `Open ${cluster.displayName || `unidentified group ${index + 1}`}`,
    );
    open.setAttribute(
      "aria-current",
      cluster.id === state.activeClusterId ? "true" : "false",
    );
    open.addEventListener("click", () => selectCluster(cluster.id));

    const thumb = document.createElement("div");
    thumb.className = "cluster-thumb";
    if (cluster.representativeFaceId) {
      const image = document.createElement("img");
      image.src = `/media/crop/${encodeURIComponent(cluster.representativeFaceId)}`;
      image.alt = "";
      image.loading = index < 4 ? "eager" : "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => image.remove(), { once: true });
      thumb.append(image);
    }

    const copy = document.createElement("div");
    copy.className = "cluster-copy";
    const title = document.createElement("strong");
    title.textContent = cluster.displayName || `Unidentified group ${index + 1}`;
    const counts = document.createElement("p");
    counts.textContent = `${pluralize(cluster.faceCount, "face")} · ${pluralize(
      cluster.photoCount,
      "photo",
    )}`;
    const status = document.createElement("span");
    status.className = "mini-status";
    status.dataset.status = cluster.status;
    status.textContent = STATUS_LABELS[cluster.status];
    copy.append(title, counts, status);

    const checkLabel = document.createElement("label");
    checkLabel.className = "merge-check-wrap";
    checkLabel.title = "Select group to merge";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = state.selectedClusterIds.has(cluster.id);
    check.disabled = cluster.status === "ignored";
    check.setAttribute(
      "aria-label",
      `Select ${cluster.displayName || `group ${index + 1}`} to merge`,
    );
    const customCheck = document.createElement("span");
    customCheck.className = "custom-check";
    customCheck.setAttribute("aria-hidden", "true");
    check.addEventListener("change", () => {
      if (check.checked) state.selectedClusterIds.add(cluster.id);
      else state.selectedClusterIds.delete(cluster.id);
      updateMergeTray();
    });
    checkLabel.append(check, customCheck);

    card.append(open, thumb, copy, checkLabel);
    return card;
  }

  function renderClusters() {
    elements.clusterList.setAttribute("aria-busy", "false");
    const count = state.clusters.length;

    if (!count) {
      elements.clusterListCount.textContent = "No groups shown";
      const empty = document.createElement("div");
      empty.className = "cluster-list-empty";
      const wrap = document.createElement("div");
      const title = document.createElement("strong");
      const copy = document.createElement("p");
      title.textContent = state.query ? "No matching groups" : "Nothing here";
      copy.textContent = state.query
        ? "Try a different name or clear your search."
        : state.filter === "unreviewed"
          ? "Every available group has been reviewed."
          : "Choose another filter to keep working.";
      wrap.append(title, copy);
      empty.append(wrap);
      elements.clusterList.replaceChildren(empty);
      return;
    }

    const renderedCount = Math.min(
      Math.max(state.renderedClusterCount, CLUSTER_RENDER_BATCH),
      count,
    );
    state.renderedClusterCount = renderedCount;
    elements.clusterListCount.textContent =
      renderedCount === count
        ? `${pluralize(count, "group")} shown`
        : `${formatNumber(renderedCount)} of ${formatNumber(count)} groups`;

    const previousTop = elements.clusterList.scrollTop;
    const previousLeft = elements.clusterList.scrollLeft;
    const fragment = document.createDocumentFragment();
    state.clusters.slice(0, renderedCount).forEach((cluster, index) => {
      fragment.append(createClusterCard(cluster, index));
    });

    if (renderedCount < count) {
      const more = document.createElement("div");
      more.className = "cluster-list-more";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button-secondary";
      const remaining = count - renderedCount;
      button.textContent = `Show ${formatNumber(
        Math.min(CLUSTER_RENDER_BATCH, remaining),
      )} more`;
      button.setAttribute(
        "aria-label",
        `Show more face groups, ${formatNumber(remaining)} remaining`,
      );
      button.addEventListener("click", () => {
        state.renderedClusterCount = Math.min(
          count,
          state.renderedClusterCount + CLUSTER_RENDER_BATCH,
        );
        renderClusters();
        updateMergeTray();
      });
      more.append(button);
      fragment.append(more);
    }

    elements.clusterList.replaceChildren(fragment);
    elements.clusterList.scrollTop = previousTop;
    elements.clusterList.scrollLeft = previousLeft;
  }

  function syncActiveCard() {
    elements.clusterList.querySelectorAll(".cluster-card").forEach((card) => {
      const active = card.dataset.clusterId === state.activeClusterId;
      card.classList.toggle("is-active", active);
      card
        .querySelector(".cluster-open")
        ?.setAttribute("aria-current", active ? "true" : "false");
    });
  }

  function updateMergeTray() {
    const count = state.selectedClusterIds.size;
    elements.mergeTray.hidden = count === 0;
    elements.mergeCount.textContent = formatNumber(count);
    elements.mergeButton.disabled = count < 2;

    elements.clusterList
      .querySelectorAll(".merge-check-wrap input")
      .forEach((checkbox) => {
        const card = checkbox.closest(".cluster-card");
        checkbox.checked = state.selectedClusterIds.has(card?.dataset.clusterId);
      });

    elements.suggestionsStrip
      .querySelectorAll("[data-suggestion-id]")
      .forEach((button) => {
        const selected = state.selectedClusterIds.has(
          button.dataset.suggestionId,
        );
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
        button.setAttribute(
          "aria-label",
          `${selected ? "Remove" : "Add"} ${
            button.dataset.suggestionName || "suggested group"
          } ${selected ? "from" : "to"} the merge selection`,
        );
        button.textContent = selected ? "Added to merge" : "Add to merge";
      });
  }

  function renderDetailLoading() {
    elements.detailEmpty.hidden = true;
    elements.detailContent.hidden = false;
    elements.faceGrid.setAttribute("aria-busy", "true");
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 8; index += 1) {
      const skeleton = document.createElement("div");
      skeleton.className = "face-skeleton";
      skeleton.setAttribute("aria-hidden", "true");
      fragment.append(skeleton);
    }
    elements.faceGrid.replaceChildren(fragment);
    elements.activeHeading.textContent = "Loading group…";
    elements.activeSummary.textContent = "Fetching face details";
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return null;
    const normalized = value <= 1 ? value * 100 : value;
    return `${Math.round(normalized)}%`;
  }

  function createFaceCard(face, index) {
    const selected = state.selectedFaceIds.has(face.id);
    const disposed = face.ignored || face.unknown;
    const card = document.createElement("article");
    card.className = "face-card";
    card.classList.toggle("is-selected", selected);
    card.classList.toggle("is-disposed", disposed);
    card.dataset.faceId = face.id;

    const checkLabel = document.createElement("label");
    checkLabel.className = "face-check";
    checkLabel.title = "Select face to split";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected;
    check.disabled = disposed;
    check.setAttribute("aria-label", `Select face ${index + 1} to split`);
    const customCheck = document.createElement("span");
    customCheck.className = "custom-check";
    customCheck.setAttribute("aria-hidden", "true");
    check.addEventListener("change", () => {
      if (check.checked) state.selectedFaceIds.add(face.id);
      else state.selectedFaceIds.delete(face.id);
      card.classList.toggle("is-selected", check.checked);
      updateFaceSelection();
    });
    checkLabel.append(check, customCheck);

    const imageButton = document.createElement("button");
    imageButton.type = "button";
    imageButton.className = "face-image";
    imageButton.disabled = !face.photoId;
    imageButton.setAttribute(
      "aria-label",
      face.photoId
        ? `View the full photo for face ${index + 1}`
        : `Full photo unavailable for face ${index + 1}`,
    );
    const image = document.createElement("img");
    image.src = `/media/crop/${encodeURIComponent(face.id)}`;
    image.alt = `Face ${index + 1} in this group`;
    image.loading = index < 10 ? "eager" : "lazy";
    image.decoding = "async";
    image.addEventListener(
      "error",
      () => {
        image.alt = `Face ${index + 1} preview unavailable`;
        image.removeAttribute("src");
      },
      { once: true },
    );
    const cue = document.createElement("span");
    cue.className = "context-cue";
    cue.innerHTML = icon("photo");
    cue.setAttribute("aria-hidden", "true");
    imageButton.append(image, cue);
    if (face.photoId) {
      imageButton.addEventListener("click", () => openPhoto(face));
    }

    const info = document.createElement("div");
    info.className = "face-info";
    const meta = document.createElement("div");
    meta.className = "face-meta";
    const number = document.createElement("span");
    number.textContent = `Face ${index + 1}`;
    const confidence = document.createElement("span");
    confidence.textContent =
      face.ignored
        ? "Ignored"
        : face.unknown
          ? "Unknown"
          : face.quality === "manual_only"
            ? "Manual review"
            : face.quality === "clusterable"
              ? "Cluster candidate"
              : "Needs review";
    confidence.className = "face-status";
    const detectionConfidence = formatPercent(face.confidence);
    if (detectionConfidence) {
      confidence.title = `Face detection confidence: ${detectionConfidence}`;
    }
    meta.append(number, confidence);

    const actions = document.createElement("div");
    actions.className = "face-actions";
    if (face.ignored || face.unknown) {
      const recover = document.createElement("button");
      recover.type = "button";
      recover.className = "recover-face";
      recover.textContent = "Return to group";
      recover.addEventListener("click", () => recoverFace(face, recover));
      actions.append(recover);
    } else {
      const unknown = document.createElement("button");
      unknown.type = "button";
      unknown.textContent = face.unknown ? "Marked unknown" : "Unknown";
      unknown.disabled = face.unknown;
      unknown.setAttribute(
        "aria-label",
        face.unknown
          ? `Face ${index + 1} is marked unknown`
          : `Mark face ${index + 1} as unknown`,
      );
      unknown.addEventListener("click", () => markFaceUnknown(face, unknown));

      const ignore = document.createElement("button");
      ignore.type = "button";
      ignore.textContent = "Ignore";
      ignore.setAttribute("aria-label", `Ignore face ${index + 1}`);
      ignore.addEventListener("click", () => ignoreFace(face, index, ignore));
      actions.append(unknown, ignore);
    }

    info.append(meta, actions);
    card.append(checkLabel, imageButton, info);
    return card;
  }

  function renderDetail() {
    const cluster = state.activeDetail;
    if (!cluster) {
      elements.detailContent.hidden = true;
      elements.detailEmpty.hidden = false;
      return;
    }

    elements.detailEmpty.hidden = true;
    elements.detailContent.hidden = false;
    elements.faceGrid.setAttribute("aria-busy", "false");

    const visibleIndex = state.clusters.findIndex(
      (item) => item.id === state.activeClusterId,
    );
    elements.activeStatus.dataset.status = cluster.status;
    elements.activeStatus.textContent = STATUS_LABELS[cluster.status];
    elements.activePosition.textContent =
      visibleIndex >= 0
        ? `Group ${visibleIndex + 1} of ${state.clusters.length}`
        : "Selected group";
    elements.activeHeading.textContent =
      cluster.displayName || "Unidentified person";
    elements.activeSummary.textContent = `${pluralize(
      cluster.faces.length || cluster.faceCount,
      "face",
    )} across ${pluralize(cluster.photoCount, "photo")}`;
    elements.personName.value = cluster.displayName;
    elements.personName.disabled = cluster.status === "ignored";
    elements.saveLabel.disabled = cluster.status === "ignored";
    elements.unknownCluster.hidden =
      cluster.status === "ignored" || cluster.status === "unknown";
    elements.unknownCluster.disabled = false;
    elements.unknownCluster.textContent = "Mark as unknown";
    elements.ignoreCluster.hidden = cluster.status === "ignored";
    elements.recoverCluster.hidden =
      cluster.status !== "ignored" && cluster.status !== "unknown";
    renderSuggestions(cluster.suggestions ?? []);
    renderBatchLabelAction(cluster);

    elements.previousCluster.disabled = state.clusters.length < 2;
    elements.nextCluster.disabled = state.clusters.length < 2;

    const fragment = document.createDocumentFragment();
    cluster.faces.forEach((face, index) => {
      fragment.append(createFaceCard(face, index));
    });

    if (!cluster.faces.length) {
      const empty = document.createElement("div");
      empty.className = "cluster-list-empty";
      const wrap = document.createElement("div");
      const title = document.createElement("strong");
      const copy = document.createElement("p");
      title.textContent = "No faces in this group";
      copy.textContent = "Refresh the workspace to check for updated results.";
      wrap.append(title, copy);
      empty.append(wrap);
      fragment.append(empty);
    }

    elements.faceGrid.replaceChildren(fragment);
    updateFaceSelection();
  }

  function suggestionSimilarity(suggestion) {
    const value = Number.isFinite(suggestion.similarity.median)
      ? suggestion.similarity.median
      : suggestion.similarity.max;
    const percent = formatPercent(value);
    return percent ? `${percent} similar` : "Similarity available";
  }

  function renderSuggestions(suggestions) {
    elements.suggestionsPanel.hidden = suggestions.length === 0;
    if (!suggestions.length) {
      elements.suggestionsStrip.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    suggestions.forEach((suggestion, index) => {
      const card = document.createElement("article");
      card.className = "suggestion-card";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "suggestion-open";
      open.setAttribute(
        "aria-label",
        `Open ${suggestion.displayName || `possible match ${index + 1}`} for comparison`,
      );

      const thumb = document.createElement("span");
      thumb.className = "suggestion-thumb";
      if (suggestion.representativeFaceId) {
        const image = document.createElement("img");
        image.src = `/media/crop/${encodeURIComponent(
          suggestion.representativeFaceId,
        )}`;
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        image.addEventListener("error", () => image.remove(), { once: true });
        thumb.append(image);
      }

      const copy = document.createElement("span");
      copy.className = "suggestion-copy";
      const name = document.createElement("strong");
      name.textContent =
        suggestion.displayName || `Unidentified group ${index + 1}`;
      const hint = document.createElement("span");
      hint.className = "suggestion-hint";
      hint.textContent = suggestionSimilarity(suggestion);
      const status = document.createElement("span");
      status.className = "mini-status";
      status.dataset.status = suggestion.status;
      status.textContent = STATUS_LABELS[suggestion.status];
      copy.append(name, hint, status);
      open.append(thumb, copy);
      open.addEventListener("click", () =>
        loadDetail(suggestion.clusterId, { announceSelection: true }),
      );

      const select = document.createElement("button");
      select.type = "button";
      select.className = "suggestion-select";
      select.dataset.suggestionId = suggestion.clusterId;
      select.dataset.suggestionName =
        suggestion.displayName || `possible match ${index + 1}`;
      select.disabled = suggestion.status === "ignored";
      const selected = state.selectedClusterIds.has(suggestion.clusterId);
      select.classList.toggle("is-selected", selected);
      select.setAttribute("aria-pressed", String(selected));
      select.setAttribute(
        "aria-label",
        suggestion.status === "ignored"
          ? "Ignored groups cannot be merged"
          : `${selected ? "Remove" : "Add"} ${
              suggestion.displayName || `possible match ${index + 1}`
            } ${selected ? "from" : "to"} the merge selection`,
      );
      select.textContent = selected ? "Added to merge" : "Add to merge";
      select.addEventListener("click", () => {
        if (state.selectedClusterIds.has(suggestion.clusterId)) {
          state.selectedClusterIds.delete(suggestion.clusterId);
          announce("Suggested group removed from the merge selection.");
        } else {
          state.selectedClusterIds.add(suggestion.clusterId);
          announce(
            "Suggested group added. Check the current group too when you are ready to merge.",
          );
        }
        updateMergeTray();
      });

      card.append(open, select);
      fragment.append(card);
    });
    elements.suggestionsStrip.replaceChildren(fragment);
  }

  function getBatchLabelProposal(cluster) {
    const suggestions = cluster.suggestions ?? [];
    const namedMatches = suggestions.filter(
      (suggestion) => suggestion.status === "labeled",
    );
    if (cluster.status === "labeled") {
      namedMatches.unshift(cluster);
    }
    if (!namedMatches.length) return null;

    if (
      namedMatches.some(
        (match) => !match.personId || !match.displayName,
      )
    ) {
      return null;
    }

    const people = new Map();
    namedMatches.forEach((match) => {
      const personId = String(match.personId);
      if (!people.has(personId)) {
        people.set(personId, match.displayName);
      }
    });
    if (people.size !== 1) return null;

    const [[personId, displayName]] = people;
    if (cluster.status === "ignored" || cluster.status === "unknown") {
      return null;
    }
    if (
      cluster.status === "labeled" &&
      (!cluster.personId || String(cluster.personId) !== personId)
    ) {
      return null;
    }

    const clusterIds = new Set();
    if (cluster.status === "unreviewed") {
      clusterIds.add(cluster.id);
    }
    suggestions.forEach((suggestion) => {
      if (suggestion.status === "unreviewed") {
        clusterIds.add(suggestion.clusterId);
      }
    });

    if (!clusterIds.size) return null;
    return {
      personId,
      displayName,
      clusterIds: [...clusterIds],
    };
  }

  function renderBatchLabelAction(cluster) {
    const proposal = getBatchLabelProposal(cluster);
    state.batchLabelProposal = proposal;
    elements.batchLabelAction.hidden = !proposal;
    if (!proposal) {
      elements.batchLabelButton.textContent = "Label groups";
      return;
    }

    const count = proposal.clusterIds.length;
    elements.batchLabelHint.textContent = `${proposal.displayName} is the only named person among these suggestions. Already-labeled groups stay unchanged.`;
    elements.batchLabelButton.textContent = `Label ${pluralize(
      count,
      "group",
    )} as ${proposal.displayName}`;
    elements.batchLabelButton.setAttribute(
      "aria-label",
      `Label ${pluralize(count, "group")} as ${proposal.displayName}`,
    );
  }

  async function batchLabelSuggestedGroups() {
    const proposal = state.batchLabelProposal;
    if (!proposal) return;
    const count = proposal.clusterIds.length;
    const confirmed = await confirmAction({
      title: `Label ${pluralize(count, "group")} as ${proposal.displayName}?`,
      message: `This assigns ${proposal.displayName} to ${pluralize(
        count,
        "unreviewed group",
      )} in one action. Already-labeled groups will not be changed.`,
      confirmLabel: `Label ${pluralize(count, "group")}`,
      danger: false,
    });
    if (!confirmed) return;

    setBusy(elements.batchLabelButton, true);
    try {
      const result = await api("/api/clusters/batch-label", {
        method: "POST",
        body: JSON.stringify({
          personId: proposal.personId,
          clusterIds: proposal.clusterIds,
          clientMutationId: crypto.randomUUID(),
        }),
      });
      const updatedCount = asNumber(result?.updatedCount, count);
      if (result?.noOp || updatedCount === 0) {
        toast("Those groups were already labeled. Nothing changed.", "info");
      } else {
        toast(
          `${pluralize(updatedCount, "group")} labeled as ${
            result?.displayName || proposal.displayName
          }.`,
        );
      }
      await loadBootstrap({
        preserveActive: state.filter !== "unreviewed",
        quiet: true,
      });
    } catch (error) {
      showError(error, "Couldn’t label the suggested groups.");
    } finally {
      setBusy(elements.batchLabelButton, false);
      renderDetail();
    }
  }

  function updateFaceSelection() {
    const count = state.selectedFaceIds.size;
    const eligibleCount = (state.activeDetail?.faces ?? []).filter(
      (face) => !face.ignored && !face.unknown,
    ).length;
    const selectedAll = count > 0 && count >= eligibleCount;
    elements.faceSelectionCount.textContent = selectedAll
      ? "Leave one face in this group"
      : count === 0
        ? "None selected"
        : pluralize(count, "face") + " selected";
    elements.clearFaceSelection.hidden = count === 0;
    elements.splitButton.disabled = count === 0 || selectedAll;

    elements.faceGrid.querySelectorAll(".face-card").forEach((card) => {
      const selected = state.selectedFaceIds.has(card.dataset.faceId);
      card.classList.toggle("is-selected", selected);
      const checkbox = card.querySelector(".face-check input");
      if (checkbox) checkbox.checked = selected;
    });
  }

  async function loadBootstrap({ preserveActive = true, quiet = false } = {}) {
    const requestId = ++state.bootstrapRequest;
    if (!quiet) renderClusterSkeletons();
    setBusy(elements.refreshButton, true);

    const params = new URLSearchParams({
      status: state.filter,
      query: state.query,
    });

    try {
      const payload = await api(`/api/bootstrap?${params}`);
      if (requestId !== state.bootstrapRequest) return;

      state.summary = payload?.summary ?? {};
      state.clusters = (Array.isArray(payload?.clusters) ? payload.clusters : [])
        .map(normalizeCluster)
        .filter((cluster) => cluster.id);
      state.renderedClusterCount = Math.min(
        CLUSTER_RENDER_BATCH,
        state.clusters.length,
      );

      const allowedIds = new Set(state.clusters.map((cluster) => cluster.id));
      for (const id of state.selectedClusterIds) {
        if (!allowedIds.has(id)) state.selectedClusterIds.delete(id);
      }

      if (
        !preserveActive ||
        !state.activeClusterId ||
        !allowedIds.has(state.activeClusterId)
      ) {
        state.activeClusterId = state.clusters[0]?.id ?? null;
      }
      const activeIndex = state.clusters.findIndex(
        (cluster) => cluster.id === state.activeClusterId,
      );
      if (activeIndex >= 0) {
        state.renderedClusterCount = Math.min(
          state.clusters.length,
          Math.max(CLUSTER_RENDER_BATCH, activeIndex + 1),
        );
      }

      renderSummary();
      renderClusters();
      updateMergeTray();

      if (state.activeClusterId) {
        await loadDetail(state.activeClusterId, { announceSelection: false });
      } else {
        state.activeDetail = null;
        state.selectedFaceIds.clear();
        renderDetail();
      }
    } catch (error) {
      if (requestId !== state.bootstrapRequest) return;
      elements.clusterList.setAttribute("aria-busy", "false");
      const empty = document.createElement("div");
      empty.className = "cluster-list-empty";
      const wrap = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = "Couldn’t load groups";
      const copy = document.createElement("p");
      copy.textContent = "Check that the local labeler is running, then refresh.";
      wrap.append(title, copy);
      empty.append(wrap);
      elements.clusterList.replaceChildren(empty);
      showError(error, "Couldn’t load the face groups.");
    } finally {
      if (requestId === state.bootstrapRequest) {
        setBusy(elements.refreshButton, false);
      }
    }
  }

  async function loadDetail(clusterId, { announceSelection = true } = {}) {
    const requestId = ++state.detailRequest;
    state.activeClusterId = clusterId;
    state.selectedFaceIds.clear();
    syncActiveCard();
    renderDetailLoading();

    try {
      const payload = await api(
        `/api/clusters/${encodeURIComponent(clusterId)}`,
      );
      if (
        requestId !== state.detailRequest ||
        clusterId !== state.activeClusterId
      ) {
        return;
      }
      state.activeDetail = normalizeDetail(payload);
      renderDetail();
      if (announceSelection) {
        announce(
          `${state.activeDetail.displayName || "Unidentified group"} opened`,
        );
      }
    } catch (error) {
      if (requestId !== state.detailRequest) return;
      state.activeDetail = null;
      renderDetail();
      showError(error, "Couldn’t load this face group.");
    }
  }

  function selectCluster(clusterId) {
    if (!clusterId || clusterId === state.activeClusterId) return;
    loadDetail(clusterId);
  }

  function moveCluster(direction) {
    if (state.clusters.length < 2) return;
    const currentIndex = Math.max(
      0,
      state.clusters.findIndex((cluster) => cluster.id === state.activeClusterId),
    );
    const nextIndex =
      (currentIndex + direction + state.clusters.length) % state.clusters.length;
    const target = state.clusters[nextIndex];
    if (nextIndex >= state.renderedClusterCount) {
      state.renderedClusterCount = Math.min(
        state.clusters.length,
        nextIndex + CLUSTER_RENDER_BATCH,
      );
      renderClusters();
      updateMergeTray();
    }
    loadDetail(target.id);

    const card = elements.clusterList.querySelector(
      `[data-cluster-id="${CSS.escape(target.id)}"]`,
    );
    card?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  async function mutateCluster(path, body, options = {}) {
    const {
      button,
      successMessage = "Group updated.",
      preserveActive = true,
    } = options;
    setBusy(button, true);
    try {
      const result = await api(path, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      toast(
        typeof successMessage === "function"
          ? successMessage(result)
          : successMessage,
      );
      await loadBootstrap({ preserveActive, quiet: true });
      return result;
    } catch (error) {
      showError(error);
      return null;
    } finally {
      setBusy(button, false);
      renderDetail();
    }
  }

  async function saveLabel(event) {
    event.preventDefault();
    if (!state.activeClusterId) return;
    const inputName = elements.personName.value.trim().replace(/\s+/g, " ");
    const firstName = inputName.split(" ")[0];
    if (!firstName) {
      elements.personName.focus();
      showError(new Error("Enter a first name before saving."));
      return;
    }
    await mutateCluster(
      `/api/clusters/${encodeURIComponent(state.activeClusterId)}/label`,
      { name: firstName },
      {
        button: elements.saveLabel,
        successMessage: (result) =>
          `${result?.displayName || firstName} saved.`,
        preserveActive: state.filter !== "unreviewed",
      },
    );
  }

  async function markClusterUnknown() {
    if (!state.activeClusterId || state.activeDetail?.status === "unknown") return;
    const confirmed = await confirmAction({
      title: "Mark this group as unknown?",
      message:
        "Keep these faces in the final review without assigning a person’s name. You can undo this action.",
      confirmLabel: "Mark unknown",
      danger: false,
    });
    if (!confirmed) return;
    await mutateCluster(
      `/api/clusters/${encodeURIComponent(state.activeClusterId)}/unknown`,
      undefined,
      {
        button: elements.unknownCluster,
        successMessage: "Group marked as unknown.",
        preserveActive: state.filter !== "unreviewed",
      },
    );
  }

  async function ignoreActiveCluster() {
    if (!state.activeClusterId || state.activeDetail?.status === "ignored") return;
    const faceCount =
      state.activeDetail?.faces.length || state.activeDetail?.faceCount || 0;
    const confirmed = await confirmAction({
      title: "Ignore this entire group?",
      message: `${pluralize(
        faceCount,
        "face",
      )} will be excluded from person labeling. You can recover the group later or undo this action.`,
      confirmLabel: "Ignore group",
      danger: true,
    });
    if (!confirmed) return;
    await mutateCluster(
      `/api/clusters/${encodeURIComponent(state.activeClusterId)}/ignore`,
      undefined,
      {
        button: elements.ignoreCluster,
        successMessage: "Group ignored.",
        preserveActive: state.filter === "ignored" || state.filter === "all",
      },
    );
  }

  async function recoverActiveCluster() {
    if (!state.activeClusterId) return;
    await mutateCluster(
      `/api/clusters/${encodeURIComponent(state.activeClusterId)}/unignore`,
      undefined,
      {
        button: elements.recoverCluster,
        successMessage: "Group returned to review.",
        preserveActive: state.filter === "unreviewed" || state.filter === "all",
      },
    );
  }

  async function mergeSelectedClusters() {
    const clusterIds = [...state.selectedClusterIds];
    if (clusterIds.length < 2) return;
    const confirmed = await confirmAction({
      title: `Merge ${clusterIds.length} groups?`,
      message:
        "All faces in the selected groups will become one person group. Review the result before assigning a name.",
      confirmLabel: "Merge groups",
      danger: false,
    });
    if (!confirmed) return;

    setBusy(elements.mergeButton, true);
    try {
      const result = await api("/api/clusters/merge", {
        method: "POST",
        body: JSON.stringify({ clusterIds }),
      });
      const mergedId =
        result?.id ??
        result?.clusterId ??
        result?.mergedClusterId ??
        result?.cluster?.id ??
        null;
      state.selectedClusterIds.clear();
      if (mergedId) state.activeClusterId = String(mergedId);
      toast(`${pluralize(clusterIds.length, "group")} merged.`);
      await loadBootstrap({
        preserveActive: Boolean(mergedId),
        quiet: true,
      });
    } catch (error) {
      showError(error, "Couldn’t merge the selected groups.");
    } finally {
      setBusy(elements.mergeButton, false);
      updateMergeTray();
    }
  }

  async function splitSelectedFaces() {
    const faceIds = [...state.selectedFaceIds];
    if (!state.activeClusterId || !faceIds.length) return;
    const confirmed = await confirmAction({
      title: `Split out ${pluralize(faceIds.length, "face")}?`,
      message:
        "The selected faces will move into a separate group for you to review and label.",
      confirmLabel: "Split faces",
      danger: false,
    });
    if (!confirmed) return;

    setBusy(elements.splitButton, true);
    try {
      await api(
        `/api/clusters/${encodeURIComponent(state.activeClusterId)}/split`,
        {
          method: "POST",
          body: JSON.stringify({ faceIds }),
        },
      );
      state.selectedFaceIds.clear();
      toast(`${pluralize(faceIds.length, "face")} split into a new group.`);
      await loadBootstrap({ preserveActive: true, quiet: true });
    } catch (error) {
      showError(error, "Couldn’t split the selected faces.");
    } finally {
      setBusy(elements.splitButton, false);
      updateFaceSelection();
    }
  }

  async function ignoreFace(face, index, button) {
    const confirmed = await confirmAction({
      title: `Ignore face ${index + 1}?`,
      message:
        "This face will be excluded from person labeling, while the rest of the group stays unchanged.",
      confirmLabel: "Ignore face",
      danger: true,
    });
    if (!confirmed) return;
    await mutateFace(
      `/api/faces/${encodeURIComponent(face.id)}/ignore`,
      button,
      "Face ignored.",
    );
  }

  async function recoverFace(face, button) {
    await mutateFace(
      `/api/faces/${encodeURIComponent(face.id)}/unignore`,
      button,
      "Face returned to the group.",
    );
  }

  async function markFaceUnknown(face, button) {
    const confirmed = await confirmAction({
      title: "Mark this face as unknown?",
      message:
        "Keep the face in your review data without connecting it to a named person.",
      confirmLabel: "Mark unknown",
      danger: false,
    });
    if (!confirmed) return;
    await mutateFace(
      `/api/faces/${encodeURIComponent(face.id)}/unknown`,
      button,
      "Face marked as unknown.",
    );
  }

  async function mutateFace(path, button, successMessage) {
    setBusy(button, true);
    try {
      await api(path, { method: "POST" });
      toast(successMessage);
      await loadBootstrap({ preserveActive: true, quiet: true });
    } catch (error) {
      showError(error, "Couldn’t update this face.");
    } finally {
      setBusy(button, false);
    }
  }

  function clearFaceSelection() {
    if (!state.selectedFaceIds.size) return false;
    state.selectedFaceIds.clear();
    updateFaceSelection();
    announce("Face selection cleared.");
    return true;
  }

  function clearClusterSelection() {
    if (!state.selectedClusterIds.size) return false;
    state.selectedClusterIds.clear();
    updateMergeTray();
    announce("Merge selection cleared.");
    return true;
  }

  function confirmAction({
    title,
    message,
    confirmLabel = "Continue",
    danger = false,
  }) {
    if (state.confirmResolve) state.confirmResolve(false);
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    elements.confirmAction.textContent = confirmLabel;
    elements.confirmAction.className = danger
      ? "button button-danger"
      : "button button-primary";

    return new Promise((resolve) => {
      state.confirmResolve = resolve;
      elements.confirmDialog.showModal();
    });
  }

  function resolveConfirmation(value) {
    if (!state.confirmResolve) return;
    const resolve = state.confirmResolve;
    state.confirmResolve = null;
    resolve(value);
  }

  function openPhoto(face) {
    if (!face.photoId) return;
    elements.photoStage.classList.remove("is-loaded");
    elements.fullPhoto.removeAttribute("src");
    elements.fullPhoto.src = `/media/photo/${encodeURIComponent(face.photoId)}`;
    elements.photoDialog.showModal();
  }

  function closePhoto() {
    if (!elements.photoDialog.open) return;
    elements.photoDialog.close();
    elements.fullPhoto.removeAttribute("src");
  }

  function renderExportPreview(payload = {}) {
    const people = Array.isArray(payload.people) ? payload.people : [];
    const photoPeople = Array.isArray(payload.photoPeople)
      ? payload.photoPeople
      : [];
    const photoPeopleCount = Array.isArray(payload.photoPeople)
      ? payload.photoPeople.length
      : asNumber(payload.photoPeople);
    const unreviewed = countValue(payload.unreviewedClusters);
    const ignored = countValue(payload.ignoredFaces);
    const unknown = countValue(payload.unknownFaces);

    const metrics = [
      [people.length, "people"],
      [photoPeopleCount, "photo links"],
      [unreviewed, "groups left"],
      [ignored + unknown, "set aside"],
    ];
    const summaryFragment = document.createDocumentFragment();
    metrics.forEach(([value, label]) => {
      const item = document.createElement("div");
      const count = document.createElement("strong");
      count.textContent = formatNumber(value);
      const copy = document.createElement("span");
      copy.textContent = label;
      item.append(count, copy);
      summaryFragment.append(item);
    });
    elements.exportSummary.replaceChildren(summaryFragment);

    const linksByPerson = new Map();
    photoPeople.forEach((link) => {
      const personId = String(link.personId ?? link.person_id ?? "");
      if (!personId) return;
      linksByPerson.set(personId, (linksByPerson.get(personId) || 0) + 1);
    });

    const peopleFragment = document.createDocumentFragment();
    people.forEach((person, index) => {
      const name = String(
        person.displayName ?? person.name ?? `Person ${index + 1}`,
      );
      const id = String(person.id ?? person.personId ?? "");
      const count = asNumber(
        person.photoCount ?? person.photo_count,
        linksByPerson.get(id) || 0,
      );
      const row = document.createElement("div");
      row.className = "export-person-row";
      const label = document.createElement("strong");
      label.textContent = name;
      const metadata = document.createElement("span");
      metadata.textContent = pluralize(count, "photo");
      row.append(label, metadata);
      peopleFragment.append(row);
    });

    if (!people.length) {
      const empty = document.createElement("p");
      empty.className = "export-empty";
      empty.textContent = "No named people are ready to export yet.";
      peopleFragment.append(empty);
    }
    elements.exportPeopleList.replaceChildren(peopleFragment);
  }

  async function openExportPreview() {
    setBusy(elements.exportButton, true);
    try {
      const payload = await api("/api/export-preview");
      renderExportPreview(payload);
      elements.exportDialog.showModal();
    } catch (error) {
      showError(error, "Couldn’t load the export preview.");
    } finally {
      setBusy(elements.exportButton, false);
    }
  }

  async function undoLastAction() {
    setBusy(elements.undoButton, true);
    try {
      const result = await api("/api/undo", { method: "POST" });
      if (result?.undone === false) {
        toast("There is no change to undo.", "info");
        return;
      }
      toast("Last change undone.");
      await loadBootstrap({ preserveActive: true, quiet: true });
    } catch (error) {
      showError(error, "There is no change to undo.");
    } finally {
      setBusy(elements.undoButton, false);
    }
  }

  function isTypingTarget(target) {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable
    );
  }

  function closeTopDialog() {
    const openDialog = [elements.confirmDialog, elements.photoDialog, elements.exportDialog]
      .find((dialog) => dialog.open);
    if (!openDialog) return false;
    if (openDialog === elements.confirmDialog) resolveConfirmation(false);
    if (openDialog === elements.photoDialog) elements.fullPhoto.removeAttribute("src");
    openDialog.close();
    return true;
  }

  let searchTimer = null;
  elements.clusterSearch.addEventListener("input", () => {
    state.query = elements.clusterSearch.value.trim();
    elements.clearSearch.hidden = !elements.clusterSearch.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      loadBootstrap({ preserveActive: false });
    }, 260);
  });

  elements.clusterSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      window.clearTimeout(searchTimer);
      loadBootstrap({ preserveActive: false });
    }
  });

  elements.clearSearch.addEventListener("click", () => {
    elements.clusterSearch.value = "";
    state.query = "";
    elements.clearSearch.hidden = true;
    elements.clusterSearch.focus();
    window.clearTimeout(searchTimer);
    loadBootstrap({ preserveActive: false });
  });

  elements.filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const status = button.dataset.status;
      if (!status || status === state.filter) return;
      state.filter = status;
      elements.filterButtons.forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      state.selectedClusterIds.clear();
      loadBootstrap({ preserveActive: false });
    });
  });

  elements.refreshButton.addEventListener("click", () => {
    loadBootstrap({ preserveActive: true });
  });
  elements.previousCluster.addEventListener("click", () => moveCluster(-1));
  elements.nextCluster.addEventListener("click", () => moveCluster(1));
  elements.labelForm.addEventListener("submit", saveLabel);
  elements.unknownCluster.addEventListener("click", markClusterUnknown);
  elements.ignoreCluster.addEventListener("click", ignoreActiveCluster);
  elements.recoverCluster.addEventListener("click", recoverActiveCluster);
  elements.batchLabelButton.addEventListener(
    "click",
    batchLabelSuggestedGroups,
  );
  elements.mergeButton.addEventListener("click", mergeSelectedClusters);
  elements.clearClusterSelection.addEventListener("click", clearClusterSelection);
  elements.splitButton.addEventListener("click", splitSelectedFaces);
  elements.clearFaceSelection.addEventListener("click", clearFaceSelection);
  elements.undoButton.addEventListener("click", undoLastAction);
  elements.exportButton.addEventListener("click", openExportPreview);
  elements.closePhoto.addEventListener("click", closePhoto);
  elements.closeExport.addEventListener("click", () => elements.exportDialog.close());

  elements.fullPhoto.addEventListener("load", () => {
    elements.photoStage.classList.add("is-loaded");
  });
  elements.fullPhoto.addEventListener("error", () => {
    elements.photoStage.classList.add("is-loaded");
    showError(new Error("The full photo could not be loaded."));
  });

  elements.confirmDialog.addEventListener("close", () => {
    const confirmed = elements.confirmDialog.returnValue === "confirm";
    resolveConfirmation(confirmed);
  });
  elements.confirmDialog.addEventListener("cancel", () => {
    resolveConfirmation(false);
  });

  [elements.photoDialog, elements.exportDialog].forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  elements.photoDialog.addEventListener("close", () => {
    elements.fullPhoto.removeAttribute("src");
  });

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (event.key === "Escape") {
      if (closeTopDialog()) {
        event.preventDefault();
        return;
      }
      if (clearFaceSelection() || clearClusterSelection()) {
        event.preventDefault();
      }
      return;
    }

    if (isTypingTarget(event.target) || document.querySelector("dialog[open]")) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "n") {
      event.preventDefault();
      moveCluster(1);
    } else if (key === "p") {
      event.preventDefault();
      moveCluster(-1);
    } else if (key === "l" && state.activeClusterId) {
      event.preventDefault();
      elements.personName.focus();
      elements.personName.select();
    } else if (
      key === "i" &&
      state.activeClusterId &&
      state.activeDetail?.status !== "ignored"
    ) {
      event.preventDefault();
      ignoreActiveCluster();
    }
  });

  loadBootstrap({ preserveActive: false });
})();
