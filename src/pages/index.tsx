import NameCombobox from "@/components/NameCombobox"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useSupabase } from "@/lib/hooks/useSupabase"
import { useUser } from "@/lib/hooks/useUser"
import { Camera, Loader2 } from "lucide-react" // ⬅️ spinner
import { Geist, Geist_Mono } from "next/font/google"
import Head from "next/head"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

const allNames = [
  "@rebeccaoharaphotography",
  "Doris Godfrey",
  "Alex Godfrey",
  "Emma McCarthy",
  "Scott DeSimone",
  "Amanda Graham",
  "Henry Malarkey 4",
  "Matthew DeSimone",
  "Laurel Fulton",
  "Anne Turberg",
  "Michael Putney",
  "Taylor DeSimone",
  "Deb Litman",
  "Stephen Schott",
  "Tye Flurie",
  "Kate Sommer",
  "Charles Mitz",
  "Jake DeSimone",
  "Charlie Malarkey ",
  "Uma Vejendla",
  "Zane Neelin",
  "Lisa Campbell ",
  "Keli Hinnant",
  "Mohamed Hussien",
  "Harvey Bell",
  "Joan Behm",
  "Logan Studley",
  "Victoria Crawford",
  "Susan Janeczek",
  "Susan Bennett",
  "Stacie Klossner",
  "Joseph Hernandez",
  "Michelle Carlson ",
  "Brenda Malarkey",
  "Sara Godfrey",
  "Gretchen VanOrden",
  "Kimberly Harrington",
  "Vincent kinduelo",
  "Graham Carson",
  "Jasmine Apicella",
  "Jerome Morris",
  "Jennifer Baker",
  "Tim Apicella",
  "Andrea Jackson",
  "Lukas Seklir",
  "Mauricio Fuhrman",
  "Moe Zaib",
  "Sahib Manjal",
  "Nathan Vogt",
  "Jariful Chowdhury",
  "Liz Godfrey",
  "Keli Curran",
  "Chris Apicella",
  "Reese Goldberg",
  "Peter Apicella",
  "Ms. Bobbie Gluck",
  "Ignazio Perez Romero",
  "Grant Rinehimer",
  "Isabella Cagno",
  "Cindy Schoberg",
  "Eric Anderson ",
  "Quinn Elliott",
  "Evie Linantud ",
  "Frank Malarkey",
  "Rick Walczak",
  "Kerry Sweatman",
  "Juan Carlos Caballero-Pérez ",
  "Paul Smitelli",
  "Sarah Harrington",
  "Angeles Cruz",
  "Vincent kinduelo ",
  "Xander Apicella",
  "Max T Gluck",
  "Charlize Trostinsky",
  "Michael (Poppy) Apicella",
  "Katie Apicella",
  "Carla Akl",
  "Tommy Sauer",
  "Julio Leanez",
  "Maya Sapozhnikov",
  "Camilo Ortiz",
  "Kyle Chen",
  "Connor Hanson",
  "John Kowalczyk",
  "Mouad Damir",
  "Dylan Beegal",
  "Steven Godfrey",
  "Sierra Apicella",
  "Tina DeSimone",
  "David Graham",
  "Kimberly Malarkey",
  "Kevin Giunta",
  "Steve Turberg",
  "Melissa",
  "Anna",
  "Joseph DeFelice ",
  "Allen Litman",
  "Julia Schott",
  "Heather Flurie",
  "Kevin Jones",
  "Kathie Malarkey",
  "Mahesh",
  "Kayla",
  "Riana Villacampa",
  "Don Behm",
  "Oliver Crawford ",
  "Mark Janeczek",
  "Wally Saucke",
  "Roger Klossner",
  "Gabriella Canale",
  "Nat Carlson",
  "Grandpa Henry Malarkey",
  "Ken Yonda",
  "Jim DeMarco",
  "Emma Brady",
  "Erik Baker",
  "Marta Apicella",
  "Edwsrds Stacy Jackson ",
  "Martin Janzen",
  "Ivan Kwong",
  "Veronica Jurrius",
  "Tasluba Bushra",
  "Alan Godfrey",
  "Krissy Reiss",
  "Max Gluck",
  "Natalia Pope",
  "Martin Salantay",
  "Lando Norris",
  "Marygrace Anderson",
  "Kamal Patel",
  "Eli Littlefield ",
  "Lisa (Frank Malarkey's Date)",
  "Kathy Petroff",
  "Kevin Sweatman",
  "Nicolette Morell",
  "Peter J Gluck",
  "Noah Martinez",
  "Michael Akl",
  "Mitchell Burrall",
  "Emma Conklin",
  "Henry Malarkey 5",
  "Nithin Vejendla",
  "Brendan Klossner",
  "Brandon VanOrden",
  "TBD Gluck ( or plus one)",
  "Ryan Malarkey ",
  "Ajay Vejendla",
  "Christin Napierkowski",
]

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
          <CardHeader className="text-center pb-2">
            <div className="flex justify-center mb-4">
              <div className="bg-rose-100 rounded-full">
                <Image
                  src="/portait.png"
                  alt="Cat"
                  width={128}
                  height={128}
                  className="h-20 w-20 text-rose-600 rounded-full"
                />
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
              unclaimedNames={allNames}
              loading={loading}
              setLoading={setLoading}
            />

            <Button
              onClick={handleContinue}
              disabled={loading || (name ? !name.trim() : false)}
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
