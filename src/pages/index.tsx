import { hasGallerySession } from "@/lib/gallery-session";
import { ArrowRight, LoaderCircle } from "lucide-react";
import type { GetServerSideProps } from "next";
import { Geist } from "next/font/google";
import Head from "next/head";
import { useRouter } from "next/router";
import { FormEvent, useState } from "react";

const geist = Geist({ subsets: ["latin"] });
const LEAVE_DURATION_MS = 520;
const SITE_URL = "https://photos.alexgodfrey.com/";
const CREATOR_URL = "https://www.alexgodfrey.com/";
const SITE_TITLE = "Alex & Sierra’s Wedding Photos | July 12, 2025";
const SITE_DESCRIPTION =
  "The private wedding photo gallery for Alex and Sierra’s lakeside celebration on July 12, 2025.";
const OG_IMAGE_URL = `${SITE_URL}og-image.jpg`;

const websiteStructuredData = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Alex & Sierra’s Wedding",
  alternateName: ["Alex & Sierra", "Alex and Sierra Wedding Photos"],
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  creator: {
    "@type": "Person",
    name: "Alex Godfrey",
    url: CREATOR_URL,
  },
};

export const getServerSideProps: GetServerSideProps = async ({ req }) => {
  try {
    if (hasGallerySession(req)) {
      return {
        redirect: {
          destination: "/gallery",
          permanent: false,
        },
      };
    }
  } catch {
    // If the server is not configured yet, render the entrance so its form
    // can provide the API's friendly configuration error.
  }

  return { props: {} };
};

export default function HomePage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const accessCode = code.trim();
    if (!accessCode || loading || leaving) return;

    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/code", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: accessCode }),
      });

      if (!response.ok) {
        let message = "That access code wasn’t recognized. Please try again.";

        try {
          const body = (await response.json()) as {
            message?: string;
            error?: string;
          };
          if (body.message || body.error) message = body.message ?? body.error!;
        } catch {
          // The friendly fallback above also covers empty error responses.
        }

        setError(message);
        setLoading(false);
        return;
      }

      void router.prefetch("/gallery");

      if (
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        setLeaving(true);
        await new Promise((resolve) =>
          window.setTimeout(resolve, LEAVE_DURATION_MS),
        );
      }

      await router.replace("/gallery");
    } catch {
      setError(
        "We couldn’t reach the gallery. Check your connection and try again.",
      );
      setLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>{SITE_TITLE}</title>
        <meta name="description" content={SITE_DESCRIPTION} />
        <meta
          name="robots"
          content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
        />
        <meta
          name="googlebot"
          content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
        />
        <link rel="canonical" href={SITE_URL} />
        <link rel="author" href={CREATOR_URL} />
        <meta name="theme-color" content="#18231d" key="theme-color" />
        <meta property="og:type" content="website" />
        <meta property="og:locale" content="en_US" />
        <meta property="og:url" content={SITE_URL} />
        <meta property="og:title" content={SITE_TITLE} />
        <meta property="og:description" content={SITE_DESCRIPTION} />
        <meta property="og:site_name" content="Alex & Sierra’s Wedding" />
        <meta property="og:image" content={OG_IMAGE_URL} />
        <meta property="og:image:secure_url" content={OG_IMAGE_URL} />
        <meta property="og:image:type" content="image/jpeg" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta
          property="og:image:alt"
          content="Alex and Sierra embracing beside the lake on their wedding day"
        />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:url" content={SITE_URL} />
        <meta name="twitter:title" content={SITE_TITLE} />
        <meta name="twitter:description" content={SITE_DESCRIPTION} />
        <meta name="twitter:image" content={OG_IMAGE_URL} />
        <meta
          name="twitter:image:alt"
          content="Alex and Sierra embracing beside the lake on their wedding day"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(websiteStructuredData).replace(
              /</g,
              "\\u003c",
            ),
          }}
        />
      </Head>

      <main
        className={`access-page ${leaving ? "is-leaving" : ""} ${geist.className}`}
      >
        <div className="access-page__wash" aria-hidden="true" />
        <div className="access-page__grain" aria-hidden="true" />

        <section className="access-panel" aria-label="Private gallery entrance">
          <h1 className="sr-only">Alex and Sierra’s wedding photographs</h1>
          <div className="access-monogram" aria-label="Alex and Sierra">
            <span>A</span>
            <i aria-hidden="true" />
            <span>S</span>
          </div>

          <form className="access-form" onSubmit={handleSubmit} noValidate>
            <div className={`access-input ${error ? "has-error" : ""}`}>
              <input
                id="access-code"
                type="text"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  if (error) setError("");
                }}
                placeholder="Access code"
                aria-label="Access code"
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                disabled={loading || leaving}
                aria-invalid={Boolean(error)}
              />
              <button
                type="submit"
                className="access-input__submit"
                disabled={!code.trim() || loading || leaving}
                aria-label="Enter gallery"
              >
                {loading || leaving ? (
                  <LoaderCircle
                    className="access-input__loader"
                    aria-hidden="true"
                  />
                ) : (
                  <ArrowRight aria-hidden="true" />
                )}
              </button>
            </div>

            <p className="access-message" role="status" aria-live="polite">
              {error}
            </p>
          </form>
        </section>

        <footer className="access-footer">
          <p className="access-date">July 12, 2025</p>
          <a className="access-credit" href={CREATOR_URL} rel="author">
            Gallery by Alex Godfrey
          </a>
        </footer>
      </main>
    </>
  );
}
