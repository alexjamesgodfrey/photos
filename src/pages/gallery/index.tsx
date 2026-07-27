import { type GalleryPhoto, PhotoCard } from "@/components/PhotoCard";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { listGalleryPhotos } from "@/lib/gallery-db";
import { hasGallerySession } from "@/lib/gallery-session";
import {
  ArrowUp,
  ChevronDown,
  Images,
  LoaderCircle,
  LogOut,
  RefreshCw,
} from "lucide-react";
import type { GetServerSideProps } from "next";
import { Geist } from "next/font/google";
import Head from "next/head";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Photo, RowsPhotoAlbum } from "react-photo-album";
import useSWRInfinite from "swr/infinite";

const geist = Geist({ subsets: ["latin"] });
const PAGE_SIZE = 48;
const MEDIA_REFRESH_LEAD_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

type SortOrder = "album" | "newest" | "oldest";

interface PhotosPage {
  photos: GalleryPhoto[];
  nextCursor: string | null;
  total: number;
  mediaExpiresAt: number;
}

interface GalleryPageProps {
  initialPage: PhotosPage | null;
}

interface AlbumLayoutPhoto extends Photo {
  galleryPhoto: GalleryPhoto;
  globalIndex: number;
}

export const getServerSideProps: GetServerSideProps<GalleryPageProps> = async ({
  req,
  res,
}) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  try {
    if (!hasGallerySession(req)) {
      return {
        redirect: {
          destination: "/",
          permanent: false,
        },
      };
    }
  } catch {
    return {
      redirect: {
        destination: "/",
        permanent: false,
      },
    };
  }

  try {
    const initialPage = await listGalleryPhotos({
      limit: PAGE_SIZE,
      sort: "album",
    });

    return {
      props: {
        initialPage,
      },
    };
  } catch (error) {
    console.error("Unable to preload gallery photos", error);
    return { props: { initialPage: null } };
  }
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sortOptions: Array<{ value: SortOrder; label: string }> = [
  { value: "album", label: "Captured order" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

async function fetchPhotos(url: string): Promise<PhotosPage> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    let message = "The gallery couldn’t be loaded.";

    try {
      const body = (await response.json()) as {
        message?: string;
        error?: string;
      };
      if (body.message || body.error) message = body.message ?? body.error!;
    } catch {
      // Preserve the user-facing fallback for empty responses.
    }

    throw new ApiError(response.status, message);
  }

  return response.json() as Promise<PhotosPage>;
}

function SkeletonGallery() {
  const heights = [
    1.34, 0.76, 1.18, 1.5, 0.86, 1.26, 0.72, 1.42, 1.05, 1.32, 0.8, 1.2,
  ];

  return (
    <div
      className="gallery-skeleton-grid"
      aria-label="Loading photographs"
      aria-busy="true"
    >
      {heights.map((ratio, index) => (
        <div
          key={index}
          className="gallery-skeleton"
          style={{ aspectRatio: `1 / ${ratio}` }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

export default function GalleryPage({ initialPage }: GalleryPageProps) {
  const router = useRouter();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<SortOrder>("album");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTopButton, setShowTopButton] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const mediaRefreshPromiseRef = useRef<{
    key: string;
    promise: Promise<unknown>;
  } | null>(null);
  const mediaErrorRefreshKeyRef = useRef<string | null>(null);

  const getKey = (pageIndex: number, previousPage: PhotosPage | null) => {
    if (previousPage && !previousPage.nextCursor) return null;

    const params = new URLSearchParams({
      sort,
      limit: String(PAGE_SIZE),
    });

    if (pageIndex > 0 && previousPage?.nextCursor) {
      params.set("cursor", previousPage.nextCursor);
    }

    return `/api/photos?${params.toString()}`;
  };

  const { data, error, isValidating, mutate, setSize } = useSWRInfinite<
    PhotosPage,
    ApiError
  >(getKey, fetchPhotos, {
    fallbackData:
      sort === "album" && initialPage ? [initialPage] : undefined,
    revalidateFirstPage: false,
    revalidateOnMount: !(sort === "album" && initialPage),
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
  });

  const hasLoadedPages = Boolean(data?.length);
  const earliestMediaExpiry = useMemo(() => {
    let earliest: number | null = null;

    for (const page of data ?? []) {
      if (
        !Number.isSafeInteger(page.mediaExpiresAt) ||
        page.mediaExpiresAt <= 0
      ) {
        continue;
      }

      earliest =
        earliest === null
          ? page.mediaExpiresAt
          : Math.min(earliest, page.mediaExpiresAt);
    }

    return earliest;
  }, [data]);
  const mediaGenerationKey = useMemo(
    () => (data ?? []).map((page) => page.mediaExpiresAt).join(":"),
    [data],
  );
  const mediaRefreshKey = `${sort}:${mediaGenerationKey}`;

  const revalidateLoadedPages = useCallback((): Promise<unknown> => {
    if (!hasLoadedPages) return Promise.resolve();
    if (mediaRefreshPromiseRef.current?.key === mediaRefreshKey) {
      return mediaRefreshPromiseRef.current.promise;
    }

    let refreshPromise: Promise<unknown>;
    // SWR Infinite revalidates every loaded page when its mutator is called
    // without replacement data.
    refreshPromise = mutate()
      .catch(() => undefined)
      .finally(() => {
        if (mediaRefreshPromiseRef.current?.promise === refreshPromise) {
          mediaRefreshPromiseRef.current = null;
        }
      });
    mediaRefreshPromiseRef.current = {
      key: mediaRefreshKey,
      promise: refreshPromise,
    };

    return refreshPromise;
  }, [hasLoadedPages, mediaRefreshKey, mutate]);

  useEffect(() => {
    if (earliestMediaExpiry === null) return;

    let timeoutId: number | undefined;

    const scheduleRefresh = () => {
      const refreshAt =
        earliestMediaExpiry * 1_000 - MEDIA_REFRESH_LEAD_MS;
      const delay = refreshAt - Date.now();

      if (delay <= 0) {
        void revalidateLoadedPages();
        return;
      }

      timeoutId = window.setTimeout(
        scheduleRefresh,
        Math.min(delay, MAX_TIMEOUT_MS),
      );
    };

    scheduleRefresh();

    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [earliestMediaExpiry, revalidateLoadedPages]);

  useEffect(() => {
    if (earliestMediaExpiry === null) return;

    const refreshIfMediaIsNearExpiry = () => {
      if (document.visibilityState !== "visible") return;

      const expiresIn = earliestMediaExpiry * 1_000 - Date.now();
      if (expiresIn <= MEDIA_REFRESH_LEAD_MS) {
        void revalidateLoadedPages();
      }
    };

    document.addEventListener(
      "visibilitychange",
      refreshIfMediaIsNearExpiry,
    );
    window.addEventListener("focus", refreshIfMediaIsNearExpiry);

    return () => {
      document.removeEventListener(
        "visibilitychange",
        refreshIfMediaIsNearExpiry,
      );
      window.removeEventListener("focus", refreshIfMediaIsNearExpiry);
    };
  }, [earliestMediaExpiry, revalidateLoadedPages]);

  const refreshAfterMediaError = useCallback(() => {
    if (
      !mediaGenerationKey ||
      mediaErrorRefreshKeyRef.current === mediaRefreshKey
    ) {
      return;
    }

    mediaErrorRefreshKeyRef.current = mediaRefreshKey;
    void revalidateLoadedPages();
  }, [mediaGenerationKey, mediaRefreshKey, revalidateLoadedPages]);

  const layoutPages = useMemo(() => {
    const seen = new Set<string>();
    let globalIndex = 0;

    return (data ?? []).map((page) => ({
      photos: page.photos.flatMap<AlbumLayoutPhoto>((photo) => {
        if (seen.has(photo.id)) return [];
        seen.add(photo.id);
        const index = globalIndex;
        globalIndex += 1;

        return [
          {
            src: photo.thumbUrl,
            width: photo.width > 0 ? photo.width : 4,
            height: photo.height > 0 ? photo.height : 5,
            key: photo.id,
            alt: "",
            galleryPhoto: photo,
            globalIndex: index,
          },
        ];
      }),
    }));
  }, [data]);

  const photos = useMemo(
    () =>
      layoutPages.flatMap((page) =>
        page.photos.map((photo) => photo.galleryPhoto),
      ),
    [layoutPages],
  );

  const lastPage = data?.[data.length - 1];
  const total = data?.[0]?.total;
  const hasMore = Boolean(lastPage?.nextCursor);
  const initialLoading = !data && !error;
  const initialError = !data && error;
  const loadingMore = Boolean(data?.length && isValidating);

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) {
      void router.replace("/");
    }
  }, [error, router]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || error) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isValidating) {
          void setSize((size) => size + 1);
        }
      },
      { rootMargin: "800px 0px", threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [error, hasMore, isValidating, setSize]);

  useEffect(() => {
    const onScroll = () => setShowTopButton(window.scrollY > 900);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!selectedId || !hasMore || isValidating) return;

    const selectedIndex = photos.findIndex((photo) => photo.id === selectedId);
    if (selectedIndex >= photos.length - 3) {
      void setSize((size) => size + 1);
    }
  }, [hasMore, isValidating, photos, selectedId, setSize]);

  const changeSort = (nextSort: SortOrder) => {
    if (nextSort === sort) return;

    const update = () => {
      setSelectedId(null);
      void setSize(1);
      setSort(nextSort);
    };

    const viewTransitionDocument = document as Document & {
      startViewTransition?: (callback: () => void) => void;
    };

    if (
      viewTransitionDocument.startViewTransition &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      viewTransitionDocument.startViewTransition(update);
    } else {
      update();
    }
  };

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);

    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } finally {
      await router.replace("/");
      setLoggingOut(false);
    }
  };

  if (error instanceof ApiError && error.status === 401) {
    return (
      <main className={`gallery-route-loader ${geist.className}`}>
        <LoaderCircle aria-hidden="true" />
        <span>Returning to the private entrance…</span>
      </main>
    );
  }

  return (
    <>
      <Head>
        <title>The Gallery — Alex &amp; Sierra</title>
        <meta
          name="description"
          content="A private collection of Alex and Sierra’s wedding photographs."
        />
        <meta name="robots" content="noindex, nofollow, noarchive" />
      </Head>

      <main className={`gallery-page ${geist.className}`}>
        <a className="skip-link" href="#photographs">
          Skip to photographs
        </a>

        <header className="gallery-header">
          <div className="gallery-header__inner">
            <a
              className="gallery-brand"
              href="#photographs"
              aria-label="Alex and Sierra — wedding gallery"
            >
              <span>A</span>
              <i aria-hidden="true" />
              <span>S</span>
            </a>

            <div className="gallery-actions">
              <label className="gallery-sort">
                <span className="sr-only">Sort photographs</span>
                <select
                  value={sort}
                  onChange={(event) =>
                    changeSort(event.target.value as SortOrder)
                  }
                  aria-label="Sort photographs"
                >
                  {sortOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="gallery-sort__chevron"
                  aria-hidden="true"
                />
              </label>

              <button
                type="button"
                className="gallery-logout"
                onClick={logout}
                disabled={loggingOut}
                aria-label="Lock gallery"
              >
                {loggingOut ? (
                  <LoaderCircle
                    className="gallery-logout__loader"
                    aria-hidden="true"
                  />
                ) : (
                  <LogOut aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        </header>

        <section
          id="photographs"
          className="gallery-content"
          aria-busy={initialLoading || loadingMore}
        >
          {initialLoading ? (
            <SkeletonGallery />
          ) : initialError ? (
            <div className="gallery-state">
              <div className="gallery-state__icon">
                <RefreshCw aria-hidden="true" />
              </div>
              <h2>The photographs are taking a moment.</h2>
              <p>
                {initialError.message ||
                  "Please check your connection and try once more."}
              </p>
              <button type="button" onClick={() => void mutate()}>
                Try again
              </button>
            </div>
          ) : photos.length === 0 ? (
            <div className="gallery-state">
              <div className="gallery-state__icon">
                <Images aria-hidden="true" />
              </div>
              <h2>The gallery is almost ready.</h2>
              <p>
                Photographs will appear here as soon as the collection is
                published.
              </p>
            </div>
          ) : (
            <>
              <div className="gallery-albums">
                {layoutPages.map((page, pageIndex) => (
                  <RowsPhotoAlbum<AlbumLayoutPhoto>
                    key={`${sort}-${pageIndex}-${page.photos[0]?.key ?? "empty"}`}
                    photos={page.photos}
                    defaultContainerWidth={1280}
                    breakpoints={[360, 600, 900, 1280, 1640]}
                    spacing={(containerWidth) =>
                      containerWidth < 600 ? 8 : 12
                    }
                    targetRowHeight={(containerWidth) =>
                      containerWidth < 600
                        ? 220
                        : containerWidth < 1200
                          ? 275
                          : 315
                    }
                    rowConstraints={{ singleRowMaxHeight: 340 }}
                    componentsProps={{
                      container: { className: "gallery-album-page" },
                    }}
                    render={{
                      photo: (_, { photo, width, height }) => (
                        <PhotoCard
                          key={photo.key ?? photo.galleryPhoto.id}
                          photo={photo.galleryPhoto}
                          index={photo.globalIndex}
                          total={total}
                          style={{ width, height }}
                          onOpen={(selected) => setSelectedId(selected.id)}
                          onMediaError={refreshAfterMediaError}
                        />
                      ),
                    }}
                  />
                ))}
              </div>

              <div ref={sentinelRef} className="gallery-pagination">
                {error ? (
                  <div className="gallery-pagination__error" role="status">
                    <span>
                      The next photographs couldn&apos;t be loaded. Everything
                      already here is still available.
                    </span>
                    <button type="button" onClick={() => void mutate()}>
                      Try again
                    </button>
                  </div>
                ) : loadingMore ? (
                  <div
                    className="gallery-pagination__loading"
                    aria-live="polite"
                  >
                    <LoaderCircle aria-hidden="true" />
                    <span>Loading more…</span>
                  </div>
                ) : hasMore ? (
                  <button
                    type="button"
                    onClick={() => void setSize((size) => size + 1)}
                  >
                    Load more photographs
                  </button>
                ) : (
                  <div className="gallery-finale" aria-hidden="true">
                    <span />
                    <p>
                      A <em>&amp;</em> S
                    </p>
                    <span />
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        {showTopButton && (
          <button
            type="button"
            className="gallery-to-top"
            onClick={() =>
              window.scrollTo({
                top: 0,
                behavior: window.matchMedia(
                  "(prefers-reduced-motion: reduce)",
                ).matches
                  ? "auto"
                  : "smooth",
              })
            }
            aria-label="Back to top"
          >
            <ArrowUp aria-hidden="true" />
          </button>
        )}

        {selectedId && (
          <PhotoLightbox
            photos={photos}
            selectedId={selectedId}
            total={total}
            onSelect={setSelectedId}
            onClose={() => setSelectedId(null)}
            onMediaError={refreshAfterMediaError}
          />
        )}
      </main>
    </>
  );
}
