import { PeopleMenu } from "@/components/PeopleMenu";
import { type GalleryPhoto, PhotoCard } from "@/components/PhotoCard";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import {
  type GalleryPerson,
  isValidGalleryPersonSlug,
  listGalleryPeople,
  listGalleryPhotos,
} from "@/lib/gallery-db";
import { hasGallerySession } from "@/lib/gallery-session";
import {
  ArrowUp,
  ChevronDown,
  Images,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Shuffle,
} from "lucide-react";
import type { GetServerSideProps } from "next";
import { Geist } from "next/font/google";
import Head from "next/head";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Photo, RowsPhotoAlbum } from "react-photo-album";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";

const geist = Geist({ subsets: ["latin"] });
const PAGE_SIZE = 48;
const MEDIA_REFRESH_LEAD_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

type SortOrder = "album" | "newest" | "oldest" | "shuffle";

interface PhotosPage {
  photos: GalleryPhoto[];
  nextCursor: string | null;
  total: number;
  mediaExpiresAt: number;
}

interface PeoplePage {
  people: GalleryPerson[];
  mediaExpiresAt: number;
}

interface GalleryPageProps {
  initialPage: PhotosPage | null;
  initialPeoplePage: PeoplePage | null;
  initialPerson: string | null;
}

interface AlbumLayoutPhoto extends Photo {
  galleryPhoto: GalleryPhoto;
  globalIndex: number;
}

export const getServerSideProps: GetServerSideProps<GalleryPageProps> = async ({
  req,
  res,
  query,
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
    const requestedPerson =
      typeof query.person === "string" ? query.person : null;
    if (
      query.person !== undefined &&
      (!requestedPerson || !isValidGalleryPersonSlug(requestedPerson))
    ) {
      return {
        redirect: {
          destination: "/gallery",
          permanent: false,
        },
      };
    }
    const [photoResult, peopleResult] = await Promise.allSettled([
      listGalleryPhotos({
        limit: PAGE_SIZE,
        sort: "album",
        person: requestedPerson ?? undefined,
      }),
      listGalleryPeople(),
    ]);
    if (photoResult.status === "rejected") throw photoResult.reason;

    const initialPage = photoResult.value;
    const initialPeoplePage =
      peopleResult.status === "fulfilled" ? peopleResult.value : null;
    if (peopleResult.status === "rejected") {
      console.error(
        "Unable to preload the gallery guest list",
        peopleResult.reason,
      );
    }

    if (
      requestedPerson &&
      initialPeoplePage &&
      !initialPeoplePage.people.some(
        (person) => person.slug === requestedPerson,
      )
    ) {
      return {
        redirect: {
          destination: "/gallery",
          permanent: false,
        },
      };
    }

    return {
      props: {
        initialPage,
        initialPeoplePage,
        initialPerson: requestedPerson,
      },
    };
  } catch (error) {
    console.error("Unable to preload gallery photos", error);
    return {
      props: {
        initialPage: null,
        initialPeoplePage: null,
        initialPerson: null,
      },
    };
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
  { value: "album", label: "Story order" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

function newShuffleSeed() {
  const bytes = new Uint8Array(8);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

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

async function fetchPeople(url: string): Promise<PeoplePage> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new ApiError(response.status, "The guest list couldn’t be loaded.");
  }

  return response.json() as Promise<PeoplePage>;
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

export default function GalleryPage({
  initialPage,
  initialPeoplePage,
  initialPerson,
}: GalleryPageProps) {
  const router = useRouter();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<SortOrder>("album");
  const [shuffleSeed, setShuffleSeed] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTopButton, setShowTopButton] = useState(false);
  const [headerHidden, setHeaderHidden] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const mediaRefreshPromiseRef = useRef<{
    key: string;
    promise: Promise<unknown>;
  } | null>(null);
  const mediaErrorRefreshKeyRef = useRef<string | null>(null);
  const routedPerson =
    typeof router.query.person === "string" ? router.query.person : null;
  const personSlug = router.isReady ? routedPerson : initialPerson;

  const {
    data: peoplePage,
    error: peopleError,
    mutate: mutatePeople,
  } = useSWR<PeoplePage, ApiError>("/api/people", fetchPeople, {
    fallbackData: initialPeoplePage ?? undefined,
    revalidateOnMount: !initialPeoplePage,
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
  });
  const people = peoplePage?.people ?? initialPeoplePage?.people ?? [];

  const getKey = (pageIndex: number, previousPage: PhotosPage | null) => {
    if (previousPage && !previousPage.nextCursor) return null;

    const params = new URLSearchParams({
      sort,
      limit: String(PAGE_SIZE),
    });

    if (pageIndex > 0 && previousPage?.nextCursor) {
      params.set("cursor", previousPage.nextCursor);
    }
    if (personSlug) params.set("person", personSlug);
    if (sort === "shuffle") {
      if (!shuffleSeed) return null;
      params.set("seed", shuffleSeed);
    }

    return `/api/photos?${params.toString()}`;
  };

  const {
    data,
    error,
    isValidating,
    mutate: mutatePhotos,
    setSize,
  } = useSWRInfinite<PhotosPage, ApiError>(getKey, fetchPhotos, {
    fallbackData:
      sort === "album" && personSlug === initialPerson && initialPage
        ? [initialPage]
        : undefined,
    revalidateFirstPage: false,
    revalidateOnMount: !(
      sort === "album" &&
      personSlug === initialPerson &&
      initialPage
    ),
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

    if (
      Number.isSafeInteger(peoplePage?.mediaExpiresAt) &&
      Number(peoplePage?.mediaExpiresAt) > 0
    ) {
      earliest =
        earliest === null
          ? Number(peoplePage?.mediaExpiresAt)
          : Math.min(earliest, Number(peoplePage?.mediaExpiresAt));
    }

    return earliest;
  }, [data, peoplePage?.mediaExpiresAt]);
  const mediaGenerationKey = useMemo(
    () =>
      [
        peoplePage?.mediaExpiresAt ?? "",
        ...(data ?? []).map((page) => page.mediaExpiresAt),
      ].join(":"),
    [data, peoplePage?.mediaExpiresAt],
  );
  const mediaRefreshKey = `${sort}:${shuffleSeed ?? "-"}:${personSlug ?? "everyone"}:${mediaGenerationKey}`;

  const revalidateMedia = useCallback((): Promise<unknown> => {
    if (!hasLoadedPages && !peoplePage) return Promise.resolve();
    if (mediaRefreshPromiseRef.current?.key === mediaRefreshKey) {
      return mediaRefreshPromiseRef.current.promise;
    }

    let refreshPromise: Promise<unknown>;
    refreshPromise = Promise.all([
      mutatePeople().catch(() => undefined),
      hasLoadedPages ? mutatePhotos().catch(() => undefined) : undefined,
    ])
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
  }, [
    hasLoadedPages,
    mediaRefreshKey,
    mutatePeople,
    mutatePhotos,
    peoplePage,
  ]);

  useEffect(() => {
    if (earliestMediaExpiry === null) return;

    let timeoutId: number | undefined;

    const scheduleRefresh = () => {
      const refreshAt =
        earliestMediaExpiry * 1_000 - MEDIA_REFRESH_LEAD_MS;
      const delay = refreshAt - Date.now();

      if (delay <= 0) {
        void revalidateMedia();
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
  }, [earliestMediaExpiry, revalidateMedia]);

  useEffect(() => {
    if (earliestMediaExpiry === null) return;

    const refreshIfMediaIsNearExpiry = () => {
      if (document.visibilityState !== "visible") return;

      const expiresIn = earliestMediaExpiry * 1_000 - Date.now();
      if (expiresIn <= MEDIA_REFRESH_LEAD_MS) {
        void revalidateMedia();
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
  }, [earliestMediaExpiry, revalidateMedia]);

  const refreshAfterMediaError = useCallback(() => {
    if (
      !mediaGenerationKey ||
      mediaErrorRefreshKeyRef.current === mediaRefreshKey
    ) {
      return;
    }

    mediaErrorRefreshKeyRef.current = mediaRefreshKey;
    void revalidateMedia();
  }, [mediaGenerationKey, mediaRefreshKey, revalidateMedia]);

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
    if (
      (error instanceof ApiError && error.status === 401) ||
      (peopleError instanceof ApiError && peopleError.status === 401)
    ) {
      void router.replace("/");
    }
  }, [error, peopleError, router]);

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
    let lastY = window.scrollY;

    const onScroll = () => {
      const y = window.scrollY;
      setShowTopButton(y > 900);

      // Collapse the header while reading downward; bring it back the moment
      // the guest scrolls up or returns near the top.
      if (y < 80) {
        setHeaderHidden(false);
      } else if (y - lastY > 4) {
        setHeaderHidden(true);
      } else if (lastY - y > 4) {
        setHeaderHidden(false);
      }

      lastY = y;
    };

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

  const withGalleryTransition = (update: () => void) => {
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

  const changeSort = (nextSort: SortOrder) => {
    if (nextSort === sort) return;
    if (nextSort === "shuffle") {
      shuffle();
      return;
    }

    withGalleryTransition(() => {
      setSelectedId(null);
      void setSize(1);
      setShuffleSeed(null);
      setSort(nextSort);
    });
  };

  const shuffle = () => {
    const seed = newShuffleSeed();

    withGalleryTransition(() => {
      setSelectedId(null);
      void setSize(1);
      setShuffleSeed(seed);
      setSort("shuffle");
    });
  };

  const changePerson = (nextPerson: string | null) => {
    if (nextPerson === personSlug) return;

    withGalleryTransition(() => {
      setSelectedId(null);
      void setSize(1);
      void router.replace(
        {
          pathname: "/gallery",
          query: nextPerson ? { person: nextPerson } : {},
        },
        undefined,
        { shallow: true, scroll: false },
      );
    });
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

  if (
    (error instanceof ApiError && error.status === 401) ||
    (peopleError instanceof ApiError && peopleError.status === 401)
  ) {
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
        <title>Gallery</title>
        <meta
          name="description"
          content="A private collection of Alex and Sierra’s wedding photographs."
        />
        <meta
          name="robots"
          content="noindex, nofollow, noarchive, noimageindex"
        />
        <meta
          name="googlebot"
          content="noindex, nofollow, noarchive, noimageindex"
        />
        <meta name="theme-color" content="#f7f3ec" key="theme-color" />
      </Head>

      <main className={`gallery-page ${geist.className}`}>
        <a className="skip-link" href="#photo-grid">
          Skip to photographs
        </a>

        <header
          className={`gallery-header ${headerHidden ? "is-hidden" : ""}`}
        >
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
              {people.length > 0 && (
                <PeopleMenu
                  people={people}
                  selectedSlug={personSlug}
                  onSelect={changePerson}
                />
              )}

              <label className="gallery-sort">
                <span className="sr-only">Sort photographs</span>
                <select
                  value={sort}
                  onChange={(event) =>
                    changeSort(event.target.value as SortOrder)
                  }
                  aria-label="Sort photographs"
                >
                  {sort === "shuffle" && (
                    <option value="shuffle">Shuffled</option>
                  )}
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
                className={`gallery-shuffle ${
                  sort === "shuffle" ? "is-active" : ""
                }`}
                onClick={shuffle}
                aria-label={
                  sort === "shuffle"
                    ? "Shuffle photographs again"
                    : "Shuffle photographs"
                }
                title="Shuffle"
              >
                <Shuffle key={shuffleSeed ?? "initial"} aria-hidden="true" />
              </button>

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
          <div
            id="photo-grid"
            className="gallery-photo-region"
            tabIndex={-1}
            role="region"
            aria-label="Photographs"
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
                <button type="button" onClick={() => void mutatePhotos()}>
                  Try again
                </button>
              </div>
            ) : photos.length === 0 ? (
              <div className="gallery-state">
                <div className="gallery-state__icon">
                  <Images aria-hidden="true" />
                </div>
                {personSlug ? (
                  <>
                    <h2>No finished photographs matched this person.</h2>
                    <p>
                      Try another face, or return to everyone in the gallery.
                    </p>
                    <button type="button" onClick={() => changePerson(null)}>
                      Show everyone
                    </button>
                  </>
                ) : (
                  <>
                    <h2>The gallery is almost ready.</h2>
                    <p>
                      Photographs will appear here as soon as the collection is
                      published.
                    </p>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="gallery-albums">
                {layoutPages.map((page, pageIndex) => (
                  <RowsPhotoAlbum<AlbumLayoutPhoto>
                    key={`${personSlug ?? "everyone"}-${sort}-${pageIndex}-${
                      page.photos[0]?.key ?? "empty"
                    }`}
                    photos={page.photos}
                    defaultContainerWidth={375}
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
                    <button
                      type="button"
                      onClick={() => void mutatePhotos()}
                    >
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
          </div>
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
