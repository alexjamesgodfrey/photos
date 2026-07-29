# SEO changelog

## 2026-07-29 — Social and search metadata foundation

- Added a 1200×630 Open Graph/Twitter preview based on the supplied lakeside wedding photograph.
- Downscaled the supplied black-and-white wedding photograph into a stable favicon set for browsers, iOS, Android, and 48×48 Search-compatible formats.
- Made only the public entrance indexable and canonical.
- Kept the authenticated gallery, people filters, and API routes excluded from indexing.
- Added consistent title, description, social metadata, `WebSite` JSON-LD, `robots.txt`, and a one-URL sitemap.

Expected impact: improved branded result clarity and link-preview quality after recrawl. Ranking movement is a hypothesis until Search Console data is available.

Rollback: restore the previous global `X-Robots-Tag` and remove the public canonical, sitemap, and `WebSite` JSON-LD.

## 2026-07-29 — Cross-site creator and error-page signals

- Added a visible, crawlable “Gallery by Alex Godfrey” creator link from the
  public entrance to the canonical profile at `www.alexgodfrey.com`.
- Added the same creator relationship to the entrance page’s `WebSite` JSON-LD
  and exposed the canonical profile through `rel="author"`.
- Added a custom 404 with a real heading, a useful return link, and
  `noindex, follow` metadata.
- Kept the relationship one-way: the gallery credits its creator, while the
  professional portfolio does not link back to the private wedding entrance.
  No private gallery URL, photo, person-filter page, or API route was made
  indexable.

Hypothesis: the matching visible and structured creator relationship will make
the connection between the wedding subdomain and Alex’s canonical profile
clearer while keeping the private gallery out of search.

Expected impact: small discovery and entity-association improvement; no ranking
change is guaranteed. The creator link is intentionally contextual and limited
to the gallery’s public entrance.

Tracking plan: verify both links and the JSON-LD in raw production HTML, then
monitor Search Console links and branded-query impressions after recrawl.

Rollback: remove the gallery creator link, `rel="author"`, and the `creator`
node; the gallery’s authentication and indexing boundaries are otherwise
unchanged.

Owner: Alex Godfrey. Recheck by: 2026-08-26.
