"use client";

import type { GalleryPerson } from "@/lib/gallery-db";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

interface PeopleFilterProps {
  people: GalleryPerson[];
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
}

interface AvatarState {
  url: string;
  failed: boolean;
  loaded: boolean;
}

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .trim();
}

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
    failed: false,
    loaded: false,
  }));
  const isCurrent = state.url === currentUrl;
  const showImage = Boolean(currentUrl) && !(isCurrent && state.failed);
  const loaded = isCurrent && state.loaded;

  useEffect(() => {
    setState((current) =>
      current.url === currentUrl
        ? current
        : { url: currentUrl, failed: false, loaded: false },
    );
  }, [currentUrl]);

  return (
    <span className={`people-avatar ${loaded ? "is-loaded" : ""}`}>
      <span className="people-avatar__fallback" aria-hidden="true">
        {person.displayName.slice(0, 1).toLocaleUpperCase("en-US")}
      </span>
      {showImage && (
        <img
          src={currentUrl}
          alt=""
          aria-hidden="true"
          width={64}
          height={64}
          loading={eager ? "eager" : "lazy"}
          fetchPriority={eager ? "high" : "auto"}
          decoding="async"
          onLoad={() =>
            setState({ url: currentUrl, failed: false, loaded: true })
          }
          onError={() =>
            setState({ url: currentUrl, failed: true, loaded: false })
          }
        />
      )}
    </span>
  );
}

export function PeopleFilter({
  people,
  selectedSlug,
  onSelect,
}: PeopleFilterProps) {
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = normalizeSearch(query);
  const visiblePeople = useMemo(
    () =>
      normalizedQuery
        ? people.filter((person) =>
            normalizeSearch(person.displayName).includes(normalizedQuery),
          )
        : people,
    [normalizedQuery, people],
  );

  return (
    <section className="people-filter" aria-labelledby="people-filter-title">
      <div className="people-filter__heading">
        <div>
          <p className="people-filter__eyebrow">The guest list</p>
          <h1 id="people-filter-title">Find your people</h1>
          <p className="people-filter__description">
            Choose a face to see every photograph they appear in.
          </p>
        </div>

        <div className="people-search">
          <label className="sr-only" htmlFor="people-search-input">
            Search people by name
          </label>
          <Search aria-hidden="true" />
          <input
            id="people-search-input"
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${people.length} people`}
            autoComplete="off"
            enterKeyHint="search"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchInputRef.current?.focus();
              }}
              aria-label="Clear people search"
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div
        className="people-filter__rail"
        role="group"
        aria-label="Filter photographs by person"
      >
        {!normalizedQuery && (
          <button
            type="button"
            className={`people-person people-person--all ${
              selectedSlug === null ? "is-selected" : ""
            }`}
            aria-pressed={selectedSlug === null}
            onClick={() => onSelect(null)}
          >
            <span className="people-avatar people-avatar--all" aria-hidden="true">
              <span>A</span>
              <i />
              <span>S</span>
            </span>
            <span className="people-person__name">Everyone</span>
            <span className="people-person__count">All photos</span>
          </button>
        )}

        {visiblePeople.map((person, index) => (
          <button
            type="button"
            key={person.id}
            className={`people-person ${
              selectedSlug === person.slug ? "is-selected" : ""
            }`}
            style={{ animationDelay: `${Math.min(index, 12) * 24}ms` }}
            aria-pressed={selectedSlug === person.slug}
            onClick={() =>
              onSelect(selectedSlug === person.slug ? null : person.slug)
            }
          >
            <PersonAvatar person={person} eager={index < 8} />
            <span className="people-person__name">{person.displayName}</span>
            <span className="people-person__count">
              {person.photoCount.toLocaleString()}{" "}
              {person.photoCount === 1 ? "photo" : "photos"}
            </span>
          </button>
        ))}
      </div>

      {normalizedQuery && visiblePeople.length === 0 && (
        <p className="people-filter__empty" role="status">
          No one named “{query.trim()}” is in the finished guest list.
        </p>
      )}
    </section>
  );
}
