import { hasGallerySession } from "@/lib/gallery-session";
import {
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
} from "lucide-react";
import type { GetServerSideProps } from "next";
import { Geist } from "next/font/google";
import Head from "next/head";
import { useRouter } from "next/router";
import { FormEvent, useState } from "react";

const geist = Geist({ subsets: ["latin"] });

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
  const [showCode, setShowCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const accessCode = code.trim();
    if (!accessCode || loading) return;

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
        return;
      }

      await router.replace("/gallery");
    } catch {
      setError(
        "We couldn’t reach the gallery. Check your connection and try again.",
      );
    } finally {
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

      <main className={`access-page ${geist.className}`}>
        <div className="access-page__wash" aria-hidden="true" />
        <div className="access-page__grain" aria-hidden="true" />

        <section className="access-shell" aria-labelledby="access-title">
          <div className="access-story">
            <div className="access-monogram" aria-label="Alex and Sierra">
              <span>A</span>
              <i aria-hidden="true" />
              <span>S</span>
            </div>

            <p className="access-eyebrow">Our wedding photographs</p>
            <h1 id="access-title">
              A day we&apos;ll
              <br />
              remember forever.
            </h1>
            <p className="access-intro">
              Come back to the celebration, the people, and all the little
              moments in between.
            </p>
          </div>

          <div className="access-card">
            <div className="access-card__icon" aria-hidden="true">
              <KeyRound />
            </div>
            <p className="access-card__eyebrow">Private collection</p>
            <h2>Enter the gallery</h2>
            <p className="access-card__copy">
              Use the access code from Alex and Sierra to view the photographs.
            </p>

            <form className="access-form" onSubmit={handleSubmit} noValidate>
              <label htmlFor="access-code">Access code</label>
              <div
                className={`access-input ${error ? "has-error" : ""} ${
                  loading ? "is-loading" : ""
                }`}
              >
                <LockKeyhole aria-hidden="true" />
                <input
                  id="access-code"
                  type={showCode ? "text" : "password"}
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value);
                    if (error) setError("");
                  }}
                  placeholder="Enter your code"
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={loading}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "access-error" : "access-hint"}
                />
                <button
                  type="button"
                  className="access-input__reveal"
                  onClick={() => setShowCode((visible) => !visible)}
                  aria-label={
                    showCode ? "Hide access code" : "Show access code"
                  }
                  disabled={loading}
                >
                  {showCode ? (
                    <EyeOff aria-hidden="true" />
                  ) : (
                    <Eye aria-hidden="true" />
                  )}
                </button>
              </div>

              <div className="access-form__message" aria-live="polite">
                {error ? (
                  <p id="access-error" className="access-error">
                    {error}
                  </p>
                ) : (
                  <p id="access-hint">The code is case-sensitive.</p>
                )}
              </div>

              <button
                type="submit"
                className="access-submit"
                disabled={!code.trim() || loading}
              >
                <span>{loading ? "Opening gallery…" : "View photographs"}</span>
                {loading ? (
                  <LoaderCircle
                    className="access-submit__loader"
                    aria-hidden="true"
                  />
                ) : (
                  <ArrowRight aria-hidden="true" />
                )}
              </button>
            </form>

            <p className="access-card__privacy">
              <LockKeyhole aria-hidden="true" />
              This gallery is shared privately with our guests.
            </p>
          </div>
        </section>

        <p className="access-date">July 12, 2025 · New York</p>
      </main>
    </>
  );
}
