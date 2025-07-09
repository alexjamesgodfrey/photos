import NameCombobox from "@/components/NameCombobox"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useSupabase } from "@/lib/hooks/useSupabase"
import { useUser } from "@/lib/hooks/useUser"
import { Camera, CatIcon, Loader2 } from "lucide-react" // ⬅️ spinner
import { Geist, Geist_Mono } from "next/font/google"
import Head from "next/head"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

const allNames = [
  "Alex Godfrey",
  "Steven Godfrey",
  "Doris Godfrey",
  "Henry Malarkey III",
  "Brenda Malarkey",
] as const

export default function HomePage() {
  const { user, refetchUser } = useUser()
  const { supabase } = useSupabase()
  const router = useRouter()

  const [name, setName] = useState("")
  const [loading, setLoading] = useState(false) // ⬅️ NEW
  const [unclaimedNames, setUnclaimedNames] = useState<string[]>([])

  /* ---------- sign-in ---------- */
  const handleContinue = async () => {
    const finalName = name.trim()
    if (!finalName) return
    localStorage.setItem("userName", finalName)

    setLoading(true) // ⬅️ start spinner
    const { data, error } = await supabase.auth.signInAnonymously()
    setLoading(false) // ⬅️ stop spinner

    if (error) console.error(error)
    if (data.user) {
      await refetchUser()
      router.push("/gallery")
    }
  }

  useEffect(() => {
    if (user) router.push("/gallery")
  }, [user, router])

  useEffect(() => {
    const go = async () => {
      setLoading(true)
      const { data: claimedNames } = await supabase
        .from("anon_name_map")
        .select("name")
      const claimed = new Set(claimedNames?.map((r) => r.name))
      const unclaimed = allNames.filter((n) => !claimed.has(n))
      setUnclaimedNames(unclaimed)
      setLoading(false)
    }

    go()
  }, [supabase])

  const isSelectable = unclaimedNames.includes(name)

  return (
    <>
      <Head>
        <title>Alex & Sierra's Wedding Photos</title>
        <meta
          name="description"
          content="Welcome to Alex & Sierra's wedding photo sharing platform. Sign in to view and share our special moments."
        />
        <meta name="robots" content="index, follow" />

        {/* Page-specific Open Graph */}
        <meta property="og:title" content="Alex & Sierra's Wedding Photos" />
        <meta
          property="og:description"
          content="Welcome to Alex & Sierra's wedding photo sharing platform. Sign in to view and share our special moments."
        />
        <meta property="og:image" content="/cover-photo.png" />

        {/* Page-specific Twitter */}
        <meta name="twitter:title" content="Alex & Sierra's Wedding Photos" />
        <meta
          name="twitter:description"
          content="Welcome to Alex & Sierra's wedding photo sharing platform. Sign in to view and share our special moments."
        />
        <meta name="twitter:image" content="/cover-photo.png" />
      </Head>

      <div
        className={`min-h-screen bg-gradient-to-br from-rose-50 to-pink-50 p-4 flex items-center justify-center ${geistSans.className} ${geistMono.className}`}
      >
        <Card className="w-full max-w-md mx-auto shadow-lg">
          <CardHeader className="text-center pb-6">
            <div className="flex justify-center mb-4">
              <div className="bg-rose-100 p-3 rounded-full">
                <CatIcon className="h-8 w-8 text-rose-600" />
              </div>
            </div>
            <CardTitle className="text-2xl font-serif text-gray-800">
              Alex &amp; Sierra&rsquo;s Wedding
            </CardTitle>
            <p className="text-gray-600 mt-2">
              Share and save our special moments
            </p>
          </CardHeader>

          <CardContent className="space-y-6">
            <label className="text-sm font-medium text-gray-700 mb-2 block">
              Your name
            </label>
            <NameCombobox
              name={name}
              setName={setName}
              unclaimedNames={unclaimedNames}
              loading={loading}
              setLoading={setLoading}
            />

            <Button
              onClick={handleContinue}
              disabled={
                loading || !isSelectable || (name ? !name.trim() : false)
              }
              className="w-full bg-rose-600 hover:bg-rose-700 text-white py-3 text-lg flex items-center justify-center gap-2"
            >
              {loading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Camera className="h-5 w-5" />
              )}
              {loading ? "Signing in…" : "Continue to Photos"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
