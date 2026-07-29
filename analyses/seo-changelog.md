# SEO changelog

## 2026-07-29 — Social and search metadata foundation

- Added a 1200×630 Open Graph/Twitter preview based on the supplied lakeside wedding photograph.
- Downscaled the supplied black-and-white wedding photograph into a stable favicon set for browsers, iOS, Android, and 48×48 Search-compatible formats.
- Made only the public entrance indexable and canonical.
- Kept the authenticated gallery, people filters, and API routes excluded from indexing.
- Added consistent title, description, social metadata, `WebSite` JSON-LD, `robots.txt`, and a one-URL sitemap.

Expected impact: improved branded result clarity and link-preview quality after recrawl. Ranking movement is a hypothesis until Search Console data is available.

Rollback: restore the previous global `X-Robots-Tag` and remove the public canonical, sitemap, and `WebSite` JSON-LD.
