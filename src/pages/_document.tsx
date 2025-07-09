import { Head, Html, Main, NextScript } from "next/document"

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* Basic Meta Tags */}
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />

        {/* SEO Meta Tags */}
        <meta
          name="description"
          content="Share and save special moments from Alex & Sierra's wedding celebration"
        />
        <meta
          name="keywords"
          content="wedding, photos, memories, celebration, Alex, Sierra"
        />
        <meta name="author" content="Alex & Sierra" />

        {/* Open Graph / Facebook */}
        <meta property="og:type" content="website" />
        <meta
          property="og:url"
          content="https://photos.wedding.alexgodfrey.com"
        />
        <meta property="og:title" content="Alex & Sierra's Wedding Photos" />
        <meta
          property="og:description"
          content="Share and save our special moments from our wedding celebration"
        />
        <meta property="og:image" content="/cover-photo.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:site_name" content="Alex & Sierra's Wedding" />

        {/* Twitter */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta
          property="twitter:url"
          content="https://photos.wedding.alexgodfrey.com"
        />
        <meta
          property="twitter:title"
          content="Alex & Sierra's Wedding Photos"
        />
        <meta
          property="twitter:description"
          content="Share and save our special moments from our wedding celebration"
        />
        <meta property="twitter:image" content="/cover-photo.png" />

        {/* Favicon and Icons */}
        <link rel="icon" href="/favicon.ico" />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/apple-touch-icon.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-32x32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/favicon-16x16.png"
        />

        {/* Preconnect to external domains for performance */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
