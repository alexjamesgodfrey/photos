import { Geist } from "next/font/google";
import Head from "next/head";
import Link from "next/link";

const geist = Geist({ subsets: ["latin"] });

export default function NotFoundPage() {
  return (
    <>
      <Head>
        <title>Page not found | Alex & Sierra’s Wedding Photos</title>
        <meta
          name="robots"
          content="noindex, follow, noarchive, noimageindex, nosnippet"
        />
      </Head>

      <main className={`not-found-page ${geist.className}`}>
        <div className="not-found-page__card">
          <p className="not-found-page__eyebrow">404</p>
          <h1>This page isn’t in the album.</h1>
          <p>The private wedding gallery entrance is still available.</p>
          <Link href="/">Return to the gallery entrance</Link>
        </div>
      </main>
    </>
  );
}
