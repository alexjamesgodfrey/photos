import type React from "react"

import { PhotoCard } from "@/components/PhotoCard"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useSupabase } from "@/lib/hooks/useSupabase"
import { useUser } from "@/lib/hooks/useUser"
import { getAccessTokenFromSupabase } from "@/lib/supabase/getAccessTokenFromSupabase"
import { uploadViaTUS } from "@/lib/uploadViaTUS"
import imageCompression from "browser-image-compression"
import {
  ArrowLeft,
  Cake,
  Camera,
  Check,
  Heart,
  Plus,
  Users,
} from "lucide-react"
import { Geist, Geist_Mono } from "next/font/google"
import Head from "next/head"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { v4 as newUUID } from "uuid"

const categories = [
  { value: "ceremony", label: "Ceremony", icon: Heart },
  { value: "reception", label: "Reception", icon: Cake },
  { value: "candid", label: "Candid", icon: Users },
]

interface Photo {
  id: string
  src: string // thumbnail
  fullSrc: string // original (hidden until download, if you like)
  name: string
  category: string
  timestamp: string
  uploader: string
}

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export default function UploadPage() {
  const { user } = useUser()
  const { supabase } = useSupabase()

  const [userName, setUserName] = useState("")
  const [selectedCategory, setSelectedCategory] = useState("ceremony")
  const [userPhotos, setUserPhotos] = useState<any[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number>(0)
  const [uploadSuccess, setUploadSuccess] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const name = localStorage.getItem("userName")
    if (!name) {
      router.push("/")
      return
    }
    setUserName(name)

    // Load user's photos from localStorage
    const savedPhotos = localStorage.getItem(`photos_${name}`)
    if (savedPhotos) {
      setUserPhotos(JSON.parse(savedPhotos))
    }
  }, [router])

  useEffect(() => {
    const go = async () => {
      await supabase.auth.signOut()
      router.push("/")
    }
    go()
  })

  useEffect(() => {
    if (!user) return
    ;(async () => {
      const { data, error } = await supabase
        .from("wedding_uploads")
        .select("id, category, file_path, created_at")
        .eq("uploader_id", user.id)
        .order("created_at", { ascending: false })

      if (error) {
        console.error(error)
        return
      }

      const mapped = data.map((row) => {
        const fullSrc = supabase.storage
          .from("wedding")
          .getPublicUrl(row.file_path).data.publicUrl

        const thumb = supabase.storage
          .from("wedding")
          .getPublicUrl(row.file_path, {
            transform: { width: 384, quality: 70 },
          }).data.publicUrl

        return {
          id: row.id,
          src: thumb,
          fullSrc,
          name: row.file_path.split("/").pop()!,
          category: row.category,
          timestamp: row.created_at,
          uploader: userName,
        } as Photo
      })

      setUserPhotos(mapped)
      localStorage.setItem(`photos_${userName}`, JSON.stringify(mapped))
    })()
  }, [user, supabase, userName])

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    if (!user?.id) return
    const rawFiles = Array.from(event.target.files ?? [])
    if (!rawFiles.length) return

    setUploading(true)
    setUploadProgress(0)

    try {
      const uploaded: Photo[] = []

      // sequential keeps the progress bar meaningful; parallel is possible too
      for (const raw of rawFiles) {
        /* ---------- 1. COMPRESS on the client ---------- */
        const file = await imageCompression(raw, {
          // tweak to taste
          maxWidthOrHeight: 1920,
          maxSizeMB: 2,
          useWebWorker: true,
        })

        /* ---------- 2. UPLOAD with PROGRESS ---------- */
        const uuid = newUUID()
        const objectPath = `${user.id}/${uuid}-${file.name}`
        const accessToken = await getAccessTokenFromSupabase(supabase)

        await uploadViaTUS({
          file,
          bucket: "wedding",
          objectPath,
          accessToken,
          onProgress: setUploadProgress,
        })

        /* ---------- 3. INSERT row ---------- */
        await supabase.from("wedding_uploads").insert({
          uploader_id: user.id,
          display_name: userName,
          category: selectedCategory,
          file_path: objectPath,
        })

        /* ---------- 4. BUILD URLs ---------- */
        const fullSrc = supabase.storage
          .from("wedding")
          .getPublicUrl(objectPath).data.publicUrl

        const thumb = supabase.storage
          .from("wedding")
          .getPublicUrl(objectPath, {
            transform: { width: 384, quality: 70 },
          }).data.publicUrl

        uploaded.push({
          id: uuid,
          src: thumb,
          fullSrc,
          name: file.name,
          category: selectedCategory,
          timestamp: new Date().toISOString(),
          uploader: userName,
        })

        // reset bar for next file
        setUploadProgress(0)
      }

      /* ---------- 5. UPDATE UI ---------- */
      const updated = [...userPhotos, ...uploaded]
      setUserPhotos(updated)
      localStorage.setItem(`photos_${userName}`, JSON.stringify(updated))
      setUploadSuccess(true)
      setTimeout(() => setUploadSuccess(false), 2000)
    } catch (err) {
      console.error(err)
      alert("Upload failed 🐱")
    } finally {
      setUploading(false)
      setUploadProgress(0)
      event.target.value = ""
    }
  }

  if (!userName) return null

  return (
    <>
      <Head>
        <title>Upload Photos - Alex & Sierra's Wedding</title>
        <meta
          name="description"
          content="Share your special moments from Alex & Sierra's wedding celebration by uploading your photos."
        />
        <meta name="robots" content="noindex, nofollow" />

        {/* Page-specific Open Graph */}
        <meta
          property="og:title"
          content="Upload Photos - Alex & Sierra's Wedding"
        />
        <meta
          property="og:description"
          content="Share your special moments from Alex & Sierra's wedding celebration by uploading your photos."
        />
        <meta property="og:image" content="/cover-photo.png" />

        {/* Page-specific Twitter */}
        <meta
          name="twitter:title"
          content="Upload Photos - Alex & Sierra's Wedding"
        />
        <meta
          name="twitter:description"
          content="Share your special moments from Alex & Sierra's wedding celebration by uploading your photos."
        />
        <meta name="twitter:image" content="/cover-photo.png" />
      </Head>

      <div
        className={`min-h-screen bg-gray-50 ${geistSans.className} ${geistMono.className}`}
      >
        {/* Header */}
        <div className="bg-white shadow-sm sticky top-0 z-10">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push("/gallery")}
                className="p-2"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <h1 className="font-serif text-lg font-semibold text-gray-800">
                Upload Photos
              </h1>
              <div className="w-10" />
            </div>
          </div>
        </div>

        <div className="p-4">
          <Tabs defaultValue="upload" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="upload">Upload New</TabsTrigger>
              <TabsTrigger value="my-photos">
                My Photos ({userPhotos.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="space-y-6 mt-6">
              {/* Upload Section */}
              <Card>
                <CardContent className="p-6">
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm font-medium text-gray-700 mb-2 block">
                        Photo Category
                      </label>
                      <Select
                        value={selectedCategory}
                        onValueChange={setSelectedCategory}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {categories.map((category) => {
                            const Icon = category.icon
                            return (
                              <SelectItem
                                key={category.value}
                                value={category.value}
                              >
                                <div className="flex items-center gap-2">
                                  <Icon className="h-4 w-4" />
                                  {category.label}
                                </div>
                              </SelectItem>
                            )
                          })}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                      <input
                        type="file"
                        multiple
                        accept="image/*"
                        onChange={handleFileUpload}
                        className="hidden"
                        id="photo-upload"
                        disabled={uploading}
                      />
                      <label
                        htmlFor="photo-upload"
                        className="cursor-pointer flex flex-col items-center gap-3"
                      >
                        {uploading ? (
                          <>
                            <p className="text-lg font-medium text-gray-700 mb-2">
                              Uploading… {uploadProgress}%
                            </p>
                            <div className="w-full h-2 bg-gray-200 rounded">
                              <div
                                className="h-full bg-rose-600 rounded transition-all"
                                style={{ width: `${uploadProgress}%` }}
                              />
                            </div>
                          </>
                        ) : uploadSuccess ? (
                          <Check className="h-8 w-8 text-green-600" />
                        ) : (
                          <Plus className="h-8 w-8 text-gray-400" />
                        )}
                        <div>
                          <p className="text-lg font-medium text-gray-700">
                            {uploading
                              ? "Uploading..."
                              : uploadSuccess
                              ? "Upload Complete!"
                              : "Add Photos"}
                          </p>
                          <p className="text-sm text-gray-500">
                            {uploading
                              ? "Please wait"
                              : "Tap to select multiple photos"}
                          </p>
                        </div>
                      </label>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Quick Stats */}
              <div className="bg-rose-50 rounded-lg p-4">
                <p className="text-center text-gray-700">
                  <span className="font-semibold text-rose-700">
                    {userName}
                  </span>
                  , you've shared{" "}
                  <span className="font-semibold">{userPhotos.length}</span>{" "}
                  photos
                </p>
              </div>
            </TabsContent>

            <TabsContent value="my-photos" className="mt-6">
              {userPhotos.length === 0 ? (
                <div className="text-center py-12">
                  <Camera className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-500">No photos uploaded yet</p>
                  <p className="text-sm text-gray-400">
                    Switch to Upload New to add photos
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {userPhotos.map((photo) => {
                    return (
                      <PhotoCard
                        key={photo.id}
                        photo={{
                          ...photo,
                          filePath: photo.fullSrc.split(
                            "/storage/v1/object/public/wedding/"
                          )[1],
                        }}
                        isOwner
                        onUpdated={(u) =>
                          setUserPhotos((prev) =>
                            prev.map((p) => (p.id === u.id ? u : p))
                          )
                        }
                        onDeleted={(id) =>
                          setUserPhotos((prev) =>
                            prev.filter((p) => p.id !== id)
                          )
                        }
                      />
                    )
                  })}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  )
}
