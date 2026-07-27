"use client";

import type { GalleryPhoto } from "@/components/PhotoCard";
import { ArrowLeft, ArrowRight, CalendarDays, ImageOff, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

interface PhotoLightboxProps {
  photos: GalleryPhoto[];
  selectedId: string;
  total?: number;
  onSelect: (id: string) => void;
  onClose: () => void;
  onMediaError?: () => void;
}

function formatCapturedAt(value: string | null) {
  if (!value) return "Alex & Sierra’s wedding";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Alex & Sierra’s wedding";

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function getPhotoAlt(
  index: number,
  total: number,
  capturedAt: string | null,
) {
  const sequence = `Photograph ${index + 1} of ${total}`;
  if (!capturedAt) return `${sequence} from Alex and Sierra’s wedding`;

  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) {
    return `${sequence} from Alex and Sierra’s wedding`;
  }

  const formattedDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);

  return `${sequence}, captured ${formattedDate}`;
}

interface ImageState {
  url: string;
  loaded: boolean;
  failed: boolean;
}

export function PhotoLightbox({
  photos,
  selectedId,
  total,
  onSelect,
  onClose,
  onMediaError,
}: PhotoLightboxProps) {
  const selectedIndex = photos.findIndex((photo) => photo.id === selectedId);
  const selectedPhoto = photos[selectedIndex];
  const currentDisplayUrl = selectedPhoto?.displayUrl ?? "";
  const [imageState, setImageState] = useState<ImageState>(() => ({
    url: currentDisplayUrl,
    loaded: false,
    failed: false,
  }));
  const [isClosing, setIsClosing] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const pointerStart = useRef<number | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const reportedFailureUrl = useRef<string | null>(null);
  const closeTimer = useRef<number | null>(null);

  const imageStateIsCurrent = imageState.url === currentDisplayUrl;
  const imageLoaded = imageStateIsCurrent && imageState.loaded;
  const imageFailed = imageStateIsCurrent && imageState.failed;
  const hasPrevious = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && selectedIndex < photos.length - 1;

  const close = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onClose();
      return;
    }
    if (closeTimer.current !== null) return;

    setIsClosing(true);
    closeTimer.current = window.setTimeout(onClose, 180);
  }, [onClose]);

  const previous = useCallback(() => {
    if (!hasPrevious) return;
    onSelect(photos[selectedIndex - 1].id);
  }, [hasPrevious, onSelect, photos, selectedIndex]);

  const next = useCallback(() => {
    if (!hasNext) return;
    onSelect(photos[selectedIndex + 1].id);
  }, [hasNext, onSelect, photos, selectedIndex]);

  useEffect(() => {
    setImageState((current) =>
      current.url === currentDisplayUrl
        ? current
        : { url: currentDisplayUrl, loaded: false, failed: false },
    );
    reportedFailureUrl.current = null;
  }, [currentDisplayUrl]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    return () => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
      }
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft") previous();
      if (event.key === "ArrowRight") next();
      if (event.key === "Tab") {
        const controls = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            ".lightbox button:not(:disabled):not([tabindex='-1'])",
          ),
        );
        if (!controls.length) return;

        const currentIndex = controls.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const nextIndex = event.shiftKey
          ? currentIndex <= 0
            ? controls.length - 1
            : currentIndex - 1
          : currentIndex === controls.length - 1
            ? 0
            : currentIndex + 1;

        event.preventDefault();
        controls[nextIndex]?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, next, previous]);

  useEffect(() => {
    const connection = (
      navigator as Navigator & {
        connection?: { saveData?: boolean };
      }
    ).connection;
    const nextUrl =
      selectedIndex >= 0
        ? photos[selectedIndex + 1]?.displayUrl
        : undefined;

    if (!nextUrl || connection?.saveData) return;

    const image = new window.Image();
    image.decoding = "async";
    image.src = nextUrl;

    return () => {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
    };
  }, [photos, selectedIndex]);

  if (!selectedPhoto) return null;

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") pointerStart.current = event.clientX;
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    if (pointerStart.current === null) return;
    const movement = event.clientX - pointerStart.current;
    pointerStart.current = null;

    if (Math.abs(movement) < 55) return;
    if (movement > 0) previous();
    else next();
  };

  return (
    <div
      className={`lightbox ${isClosing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Wedding photo viewer"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <button
        type="button"
        className="lightbox__backdrop"
        onClick={close}
        aria-label="Close photo viewer"
        tabIndex={-1}
      />

      <div className="lightbox__topbar">
        <div className="lightbox__count" aria-live="polite">
          {selectedIndex + 1}
          <span aria-hidden="true"> / </span>
          <span className="sr-only"> of </span>
          {total ?? photos.length}
        </div>

        <button
          ref={closeButtonRef}
          type="button"
          className="lightbox__icon-button"
          onClick={close}
          aria-label="Close photo viewer"
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <div className="lightbox__stage">
        {!imageLoaded && !imageFailed && (
          <div
            className="lightbox__loader"
            role="status"
            aria-label="Loading photograph"
          >
            <span aria-hidden="true" />
          </div>
        )}

        {imageFailed && (
          <div className="lightbox__error" role="status">
            <ImageOff aria-hidden="true" />
            <span>This photograph couldn’t be loaded.</span>
          </div>
        )}

        <img
          key={selectedPhoto.displayUrl}
          src={selectedPhoto.displayUrl}
          alt={getPhotoAlt(
            selectedIndex,
            total ?? photos.length,
            selectedPhoto.capturedAt,
          )}
          width={selectedPhoto.width > 0 ? selectedPhoto.width : 4}
          height={selectedPhoto.height > 0 ? selectedPhoto.height : 5}
          decoding="async"
          className={`lightbox__image ${
            imageLoaded && !imageFailed ? "is-loaded" : ""
          }`}
          draggable={false}
          onLoad={() =>
            setImageState({
              url: selectedPhoto.displayUrl,
              loaded: true,
              failed: false,
            })
          }
          onError={() => {
            setImageState({
              url: selectedPhoto.displayUrl,
              loaded: false,
              failed: true,
            });

            if (reportedFailureUrl.current !== selectedPhoto.displayUrl) {
              reportedFailureUrl.current = selectedPhoto.displayUrl;
              onMediaError?.();
            }
          }}
        />
      </div>

      <button
        type="button"
        className="lightbox__nav lightbox__nav--previous"
        onClick={previous}
        disabled={!hasPrevious}
        aria-label="Previous photo"
      >
        <ArrowLeft aria-hidden="true" />
      </button>

      <button
        type="button"
        className="lightbox__nav lightbox__nav--next"
        onClick={next}
        disabled={!hasNext}
        aria-label="Next photo"
      >
        <ArrowRight aria-hidden="true" />
      </button>

      <div className="lightbox__caption">
        <CalendarDays aria-hidden="true" />
        <span>{formatCapturedAt(selectedPhoto.capturedAt)}</span>
      </div>
    </div>
  );
}
