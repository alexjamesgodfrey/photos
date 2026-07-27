import { hasGallerySession } from "@/lib/gallery-session";
import { ArrowRight, LoaderCircle } from "lucide-react";
import type { GetServerSideProps } from "next";
import { Geist } from "next/font/google";
import Head from "next/head";
import { useRouter } from "next/router";
import { FormEvent, useState } from "react";

const geist = Geist({ subsets: ["latin"] });
const LEAVE_DURATION_MS = 520;

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
        <title>Alex &amp; Sierra — Wedding Photos</title>
        <meta
          name="description"
          content="A private collection of memories from Alex and Sierra’s wedding."
        />
        <meta name="robots" content="noindex, nofollow, noarchive" />
        <meta property="og:title" content="Alex & Sierra — Wedding Photos" />
        <meta
          property="og:description"
          content="A private collection of memories from Alex and Sierra’s wedding."
        />
      </Head>

      <main
        className={`access-page ${leaving ? "is-leaving" : ""} ${geist.className}`}
      >
        <div className="access-page__wash" aria-hidden="true" />
        <div className="access-page__grain" aria-hidden="true" />

        <section className="access-panel" aria-label="Private gallery entrance">
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

        <p className="access-date">July 12, 2025 · New York</p>
      </main>
    </>
  );
}
