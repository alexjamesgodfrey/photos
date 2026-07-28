import { Head, Html, Main, NextScript } from "next/document"

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />

        <meta
          name="description"
          content="A private gallery of Alex and Sierra's wedding photographs."
        />
        <meta name="author" content="Alex & Sierra" />
        <meta name="robots" content="noindex, nofollow, noarchive" />

        <meta property="og:type" content="website" />
        <meta
          property="og:url"
          content="https://photos.alexgodfrey.com"
        />
        <meta property="og:title" content="Alex & Sierra's Wedding Photos" />
        <meta
          property="og:description"
          content="A private gallery of our wedding photographs."
        />
        <meta property="og:site_name" content="Alex & Sierra's Wedding" />

        <meta property="twitter:card" content="summary_large_image" />
        <meta
          property="twitter:url"
          content="https://photos.alexgodfrey.com"
        />
        <meta
          property="twitter:title"
          content="Alex & Sierra's Wedding Photos"
        />
        <meta
          property="twitter:description"
          content="A private gallery of our wedding photographs."
        />
        <link
          rel="icon"
          type="image/x-icon"
          sizes="32x32"
          href="/favicon-32x32.ico"
        />
        <link
          rel="icon"
          type="image/x-icon"
          sizes="16x16"
          href="/favicon-16x16.ico"
        />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
