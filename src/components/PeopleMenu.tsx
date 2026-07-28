"use client";

import type { GalleryPerson } from "@/lib/gallery-db";
import { ChevronDown, Search, Users } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface PeopleMenuProps {
  people: GalleryPerson[];
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
}

interface AvatarState {
  url: string;
  loaded: boolean;
  failed: boolean;
}

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .trim();
}

// The couple leads the guest list; everyone else stays alphabetical.
const FEATURED_NAMES = ["alex", "sierra"];

function PersonAvatar({
  person,
  eager,
}: {
  person: GalleryPerson;
  eager: boolean;
}) {
  const currentUrl = person.avatarUrl ?? "";
  const [state, setState] = useState<AvatarState>(() => ({
    url: currentUrl,
    loaded: false,
    failed: false,
  }));
  const imageRef = useRef<HTMLImageElement | null>(null);
  const isCurrent = state.url === currentUrl;
  const showImage = Boolean(currentUrl) && !(isCurrent && state.failed);
  const loaded = isCurrent && state.loaded;

  useEffect(() => {
    setState((current) =>
      current.url === currentUrl
        ? current
        : { url: currentUrl, loaded: false, failed: false },
    );
  }, [currentUrl]);

  // Cached avatars can be complete before the load listener attaches.
  useEffect(() => {
    const image = imageRef.current;
    if (!image || !image.complete || image.naturalWidth === 0) return;

    setState((current) =>
      current.url === currentUrl && current.loaded
        ? current
        : { url: currentUrl, loaded: true, failed: false },
    );
  }, [currentUrl]);

  return (
    <span
      className={`people-menu__avatar ${loaded ? "is-loaded" : ""}`}
      aria-hidden="true"
    >
      <span>{person.displayName.slice(0, 1).toLocaleUpperCase("en-US")}</span>
      {showImage && (
        <img
          ref={imageRef}
          src={currentUrl}
          alt=""
          width={64}
          height={64}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={() =>
            setState({ url: currentUrl, loaded: true, failed: false })
          }
          onError={() =>
            setState({ url: currentUrl, loaded: false, failed: true })
          }
        />
      )}
    </span>
  );
}

export function PeopleMenu({ people, selectedSlug, onSelect }: PeopleMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = people.find((person) => person.slug === selectedSlug) ?? null;
  const normalizedQuery = normalizeSearch(query);
  const orderedPeople = useMemo(() => {
    const featured: GalleryPerson[] = [];
    const rest: GalleryPerson[] = [];

    for (const person of people) {
      const featuredIndex = FEATURED_NAMES.indexOf(
        normalizeSearch(person.displayName),
      );
      if (featuredIndex >= 0) featured[featuredIndex] = person;
      else rest.push(person);
    }

    return [...featured.filter(Boolean), ...rest];
  }, [people]);
  const visiblePeople = useMemo(
    () =>
      normalizedQuery
        ? orderedPeople.filter((person) =>
            normalizeSearch(person.displayName).includes(normalizedQuery),
          )
        : orderedPeople,
    [normalizedQuery, orderedPeople],
  );

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    setQuery("");
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  // Lock the page while the menu is open so touch scrolling stays inside the
  // people list instead of dragging the gallery underneath it.
  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    // Autofocus only where a hardware keyboard is likely; on touch devices
    // the software keyboard would cover the list the guest wants to scroll.
    if (
      open &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches
    ) {
      searchRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  const choose = (slug: string | null) => {
    close(true);
    onSelect(slug);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!open) return;

    if (event.key === "Escape") {
      event.stopPropagation();
      close(true);
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    if (!options.length) return;

    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === "ArrowDown") {
      options[Math.min(index + 1, options.length - 1)]?.focus();
    } else if (index <= 0) {
      searchRef.current?.focus();
    } else {
      options[index - 1]?.focus();
    }
  };

  return (
    <div className="people-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        className="people-menu__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filter photographs by person"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {selected ? (
          <PersonAvatar person={selected} eager />
        ) : (
          <span
            className="people-menu__avatar people-menu__avatar--all"
            aria-hidden="true"
          >
            <Users aria-hidden="true" />
          </span>
        )}
        <span className="people-menu__label">
          {selected ? selected.displayName : "Everyone"}
        </span>
        <ChevronDown
          className={`people-menu__chevron ${open ? "is-open" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="people-menu__panel">
          <div className="people-menu__search">
            <Search aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${people.length} people`}
              aria-label="Search people by name"
              autoComplete="off"
              enterKeyHint="search"
            />
          </div>

          <div
            className="people-menu__list"
            role="listbox"
            aria-label="Filter photographs by person"
            ref={listRef}
          >
            {!normalizedQuery && (
              <button
                type="button"
                role="option"
                aria-selected={!selected}
                className={`people-menu__option ${!selected ? "is-selected" : ""}`}
                onClick={() => choose(null)}
              >
                <span
                  className="people-menu__avatar people-menu__avatar--all"
                  aria-hidden="true"
                >
                  <Users aria-hidden="true" />
                </span>
                <span className="people-menu__name">Everyone</span>
              </button>
            )}

            {visiblePeople.map((person, index) => (
              <button
                type="button"
                key={person.id}
                role="option"
                aria-selected={selectedSlug === person.slug}
                className={`people-menu__option ${
                  selectedSlug === person.slug ? "is-selected" : ""
                }`}
                onClick={() => choose(person.slug)}
              >
                <PersonAvatar person={person} eager={index < 12} />
                <span className="people-menu__name">{person.displayName}</span>
                <span className="people-menu__count">
                  {person.photoCount.toLocaleString()}
                </span>
              </button>
            ))}

            {normalizedQuery && visiblePeople.length === 0 && (
              <p className="people-menu__empty" role="status">
                No matches for “{query.trim()}”.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
