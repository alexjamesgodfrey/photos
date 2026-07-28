"use client";

import { ImageIcon } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";

export interface GalleryPhoto {
  id: string;
  thumbUrl: string;
  displayUrl: string;
  width: number;
  height: number;
  capturedAt: string | null;
  filename: string;
  blurDataUrl?: string | null;
}

export interface PhotoCardProps {
  photo: GalleryPhoto;
  index: number;
  total?: number;
  onOpen: (photo: GalleryPhoto) => void;
  onMediaError?: () => void;
  style?: CSSProperties;
}

interface ImageState {
  url: string;
  loaded: boolean;
  failed: boolean;
}

export function PhotoCard({
  photo,
  index,
  total,
  onOpen,
  onMediaError,
  style,
}: PhotoCardProps) {
  const [imageState, setImageState] = useState<ImageState>(() => ({
    url: photo.thumbUrl,
    loaded: false,
    failed: false,
  }));
  const reportedFailureUrl = useRef<string | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const imageStateIsCurrent = imageState.url === photo.thumbUrl;
  const loaded = imageStateIsCurrent && imageState.loaded;
  const failed = imageStateIsCurrent && imageState.failed;

  useEffect(() => {
    setImageState((current) =>
      current.url === photo.thumbUrl
        ? current
        : { url: photo.thumbUrl, loaded: false, failed: false },
    );
    reportedFailureUrl.current = null;
  }, [photo.thumbUrl]);

  // The first eager images can finish downloading before React hydrates, so
  // their load/error events fire with no listener attached and the card would
  // shimmer forever. Reconcile against the DOM once we're mounted.
  useEffect(() => {
    const image = imageRef.current;
    if (!image || !image.complete) return;

    if (image.naturalWidth > 0) {
      setImageState((current) =>
        current.url === photo.thumbUrl && current.loaded
          ? current
          : { url: photo.thumbUrl, loaded: true, failed: false },
      );
      return;
    }

    setImageState((current) =>
      current.url === photo.thumbUrl && current.failed
        ? current
        : { url: photo.thumbUrl, loaded: false, failed: true },
    );
    if (reportedFailureUrl.current !== photo.thumbUrl) {
      reportedFailureUrl.current = photo.thumbUrl;
      onMediaError?.();
    }
  }, [onMediaError, photo.thumbUrl]);

  const safeWidth = photo.width > 0 ? photo.width : 4;
  const safeHeight = photo.height > 0 ? photo.height : 5;
  const intrinsicHeight = Math.round((400 * safeHeight) / safeWidth);

  const cardStyle: CSSProperties = {
    ...style,
    animationDelay: `${Math.min(index, 12) * 35}ms`,
    contentVisibility: "auto",
    containIntrinsicSize: `400px ${intrinsicHeight}px`,
  };

  const mediaStyle: CSSProperties = {
    aspectRatio: `${safeWidth} / ${safeHeight}`,
    backgroundImage: photo.blurDataUrl
      ? `url("${photo.blurDataUrl.replaceAll('"', '\\"')}")`
      : undefined,
  };

  return (
    <article className="gallery-card" style={cardStyle}>
      <button
        type="button"
        className="gallery-card__button"
        onClick={() => onOpen(photo)}
        aria-label={`Open photograph ${index + 1}${
          typeof total === "number" ? ` of ${total}` : ""
        }`}
      >
        <span className="gallery-card__media" style={mediaStyle}>
          {!failed ? (
            <img
              key={photo.thumbUrl}
              ref={imageRef}
              src={photo.thumbUrl}
              alt=""
              aria-hidden="true"
              width={safeWidth}
              height={safeHeight}
              loading={index < 6 ? "eager" : "lazy"}
              fetchPriority={index < 3 ? "high" : "auto"}
              decoding="async"
              className={`gallery-card__image ${loaded ? "is-loaded" : ""}`}
              onLoad={() =>
                setImageState({
                  url: photo.thumbUrl,
                  loaded: true,
                  failed: false,
                })
              }
              onError={() => {
                setImageState({
                  url: photo.thumbUrl,
                  loaded: false,
                  failed: true,
                });

                if (reportedFailureUrl.current !== photo.thumbUrl) {
                  reportedFailureUrl.current = photo.thumbUrl;
                  onMediaError?.();
                }
              }}
            />
          ) : (
            <span className="gallery-card__fallback" aria-hidden="true">
              <ImageIcon aria-hidden="true" />
              <span>Image unavailable</span>
            </span>
          )}

          {!loaded && !failed && (
            <span className="gallery-card__shimmer" aria-hidden="true" />
          )}
        </span>
      </button>
    </article>
  );
}
