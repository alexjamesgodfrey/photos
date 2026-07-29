# SEO source log

Checked on 2026-07-29 against primary documentation.

| Claim implemented | Confidence | Source |
| --- | --- | --- |
| Pages Router titles and page-specific metadata belong in `next/head`; `_document` is reserved for markup common to every page. | confirmed | [Next.js Custom Document](https://nextjs.org/docs/pages/building-your-application/routing/custom-document) |
| A preferred Google site name is expressed with one `WebSite` JSON-LD node on the crawlable home page and should agree with the title and `og:site_name`. | confirmed | [Google Search Central: Site names](https://developers.google.com/search/docs/appearance/site-names) |
| `noindex` can be set per private HTML route with robots metadata or `X-Robots-Tag`; `max-image-preview:large` permits a large preview for the public page. | confirmed | [Google Search Central: Robots meta tags](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) |
| A stable square favicon should be crawlable and is recommended at 48×48 pixels or larger for Search surfaces. | confirmed | [Google Search Central: Favicons](https://developers.google.com/search/docs/appearance/favicon-in-search) |
| The public root uses a self-referencing canonical so duplicate URL signals converge on one preferred URL. | confirmed | [Google Search Central: Canonical URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) |

## Privacy boundary

The public access page is indexable for the branded query family. The authenticated gallery, person-filter variants, and API routes remain explicitly `noindex`; no private photograph URL or guest identity is included in the sitemap or structured data.
