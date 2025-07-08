import NameCombobox from "@/components/NameCombobox"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { useSupabase } from "@/lib/hooks/useSupabase"
import { useUser } from "@/lib/hooks/useUser"
import { Camera, Loader2 } from "lucide-react" // ⬅️ spinner
import { Geist, Geist_Mono } from "next/font/google"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export default function HomePage() {
  const { user, refetchUser } = useUser()
  const { supabase } = useSupabase()
  const router = useRouter()

  const [name, setName] = useState("")
  const [loading, setLoading] = useState(false) // ⬅️ NEW

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

  return (
    <div
      className={`min-h-screen bg-gradient-to-br from-rose-50 to-pink-50 p-4 flex items-center justify-center ${geistSans.className} ${geistMono.className}`}
    >
      <Card className="w-full max-w-md mx-auto shadow-lg">
        <CardHeader className="text-center pb-6">
          {/* … header unchanged … */}
        </CardHeader>

        <CardContent className="space-y-6">
          <label className="text-sm font-medium text-gray-700 mb-2 block">
            Your name
          </label>
          <NameCombobox name={name} setName={setName} />

          <Button
            onClick={handleContinue}
            disabled={loading || !name.trim()}
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
  )
}
