"use client"

import { PhotoCard } from "@/components/PhotoCard"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSupabase } from "@/lib/hooks/useSupabase"
import { weddingUniqueDisplayNames } from "@/lib/supabase/rpc/weddingUniqueDisplayNames"
import { WeddingUploads } from "@/types/supabaseAlias"
import { RealtimePostgresInsertPayload } from "@supabase/supabase-js"
import clsx from "clsx"
import {
  Cake,
  Camera,
  CatIcon as FelineIcon,
  Filter,
  Heart,
  Upload,
  User as UserIcon,
  Users,
} from "lucide-react"
import { Geist, Geist_Mono } from "next/font/google"
import Head from "next/head"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import useSWRInfinite from "swr/infinite"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

const PAGE_SIZE = 12

const categories = [
  { value: "all", label: "All Photos", icon: Camera },
  { value: "professional", label: "Professional", icon: Camera },
  { value: "ceremony", label: "Ceremony", icon: Heart },
  { value: "reception", label: "Reception", icon: Cake },
  { value: "candid", label: "Candid", icon: Users },
] as const

type CategoryVal = (typeof categories)[number]["value"]

interface Photo {
  id: string
  src: string // thumb
  fullSrc: string // original
  uploader: string
  category: CategoryVal
  timestamp: string
  filePath: string
}

export default function GalleryPage() {
  const { supabase } = useSupabase()
  const router = useRouter()

  const [userName, setUserName] = useState("")
  const [selectedCat, setSelectedCat] = useState<CategoryVal>("all")
  const [selectedUploader, setSelectedUploader] = useState<string>("all")
  const [photosCount, setPhotosCount] = useState(0)
  const [uploaders, setUploaders] = useState<string[]>([])
  const [loadingUploaders, setLoadingUploaders] = useState(false)

  /* ---------- 1.  Auth guard & user name ---------- */
  useEffect(() => {
    const name = localStorage.getItem("userName")
    if (!name) {
      router.push("/")
      return
    }
    setUserName(name)
  }, [router])

  /* ---------- 2.  Fetch unique display names ---------- */
  useEffect(() => {
    let active = true
    setLoadingUploaders(true)
    weddingUniqueDisplayNames(supabase)
      .then((names) => {
        if (!active) return
        setUploaders(names)
      })
      .finally(() => active && setLoadingUploaders(false))
    return () => {
      active = false
    }
  }, [supabase])

  /* ---------- 3.  Count matching photos (category + uploader) ---------- */
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      // If you implemented the enhanced RPC use that here; otherwise head count:
      let query = supabase
        .from("wedding_uploads")
        .select("*", { count: "exact", head: true })

      if (selectedCat !== "all") query = query.eq("category", selectedCat)
      if (selectedUploader !== "all") {
        query = query.eq("display_name", selectedUploader)
      }

      const { count, error } = await query
      if (error) {
        console.error("Count error", error)
        return
      }
      if (!cancelled) setPhotosCount(count || 0)
    }
    run()
    return () => {
      cancelled = true
    }
  }, [supabase, selectedCat, selectedUploader])

  /* ---------- 4.  SWR infinite (key includes both filters) ---------- */
  const getKey = (
    index: number,
    prev: WeddingUploads[] | null
  ): { index: number; cat: CategoryVal; uploader: string } | null => {
    if (prev && !prev.length) return null
    return { index, cat: selectedCat, uploader: selectedUploader }
  }

  const fetcher = async (key: {
    index: number
    cat: CategoryVal
    uploader: string
  }) => {
    const from = key.index * PAGE_SIZE
    const to = from + PAGE_SIZE - 1

    let q = supabase
      .from("wedding_uploads")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, to)

    if (key.cat !== "all") q = q.eq("category", key.cat)
    if (key.uploader !== "all") q = q.eq("display_name", key.uploader)

    const { data, error } = await q
    if (error) throw error
    return data as WeddingUploads[]
  }

  const { data, size, setSize, isValidating, mutate } = useSWRInfinite<
    WeddingUploads[]
  >(getKey, fetcher, { revalidateOnFocus: false })

  /* ---------- 5.  Map DB rows to UI objects ---------- */
  const mapRow = useCallback(
    (row: WeddingUploads): Photo => {
      const pub = supabase.storage.from("wedding")
      const full = pub.getPublicUrl(row.file_path).data.publicUrl
      const thumb = pub.getPublicUrl(row.file_path, {
        transform: { width: 384, quality: 70 },
      }).data.publicUrl

      return {
        id: row.id,
        src: thumb,
        fullSrc: full,
        uploader: row.display_name,
        // @ts-ignore
        category: row.category,
        timestamp: row.created_at,
        filePath: row.file_path,
      }
    },
    [supabase]
  )

  const photos: Photo[] = data ? data.flat().map(mapRow) : []

  /* ---------- 6.  Infinite scroll sentinel ---------- */
  const sentinel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = sentinel.current
    if (!el) return

    let loading = false

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting && !loading) {
          loading = true
          setSize((s) => s + 1)
          queueMicrotask(() => {
            loading = false
          })
        }
      },
      {
        root: null,
        rootMargin: "200px 0px 200px 0px",
        threshold: 0,
      }
    )

    io.observe(el)
    return () => io.disconnect()
  }, [setSize, selectedCat, selectedUploader, photos.length])

  /* ---------- 7.  Realtime new-photo subscription (respect filters) ---------- */
  useEffect(() => {
    const channel = supabase
      .channel("rt-uploads")
      .on<WeddingUploads>(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "wedding_uploads" },
        (payload: RealtimePostgresInsertPayload<WeddingUploads>) => {
          const newRow = payload.new
          // Filter gating:
          if (
            (selectedCat !== "all" && newRow.category !== selectedCat) ||
            (selectedUploader !== "all" &&
              newRow.display_name !== selectedUploader)
          ) {
            return
          }

          mutate<WeddingUploads[][]>((pages) => {
            if (!pages) return [[newRow]]
            return [[newRow, ...pages[0]], ...pages.slice(1)]
          }, false)
          // Increment count locally (optimistic)
          setPhotosCount((c) => c + 1)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [mutate, supabase, selectedCat, selectedUploader])

  /* ---------- 8.  Helpers ---------- */
  const CatIcon = (cat: CategoryVal) =>
    categories.find((c) => c.value === cat)?.icon ?? Camera

  // Reset pagination when filter changes (SWR key ensures cache separation, but we cap size)
  useEffect(() => {
    setSize(1)
  }, [selectedCat, selectedUploader, setSize])

  if (!userName) return null

  return (
    <>
      <Head>
        <title>Wedding Gallery - Alex & Sierra's Wedding</title>
        <meta
          name="description"
          content="Browse and view all the special moments from Alex & Sierra's wedding celebration."
        />
        <meta name="robots" content="noindex, nofollow" />
        <meta
          property="og:title"
          content="Wedding Gallery - Alex & Sierra's Wedding"
        />
        <meta
          property="og:description"
          content="Browse and view all the special moments from Alex & Sierra's wedding celebration."
        />
        <meta property="og:image" content="/cover-photo.png" />
        <meta
          name="twitter:title"
          content="Wedding Gallery - Alex & Sierra's Wedding"
        />
        <meta
          name="twitter:description"
          content="Browse and view all the special moments from Alex & Sierra's wedding celebration."
        />
        <meta name="twitter:image" content="/cover-photo.png" />
      </Head>

      <div
        className={`min-h-screen bg-gray-50 ${geistSans.className} ${geistMono.className}`}
      >
        {/* ── Header ─────────────────────── */}
        <div className="bg-white shadow-sm sticky top-0 z-10">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => console.log("hi")}
                className="p-2"
              >
                <FelineIcon className="h-5 w-5 text-black" />
              </Button>

              <h1 className="font-serif text-lg font-semibold text-gray-800">
                Wedding Gallery
              </h1>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push("/upload")}
                className="p-2"
              >
                <Upload className="h-5 w-5 text-black" />
              </Button>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              {/* Category Filter */}
              <div className="flex items-center gap-2 flex-1">
                <Filter className="h-4 w-4 text-gray-500" />
                <Select
                  value={selectedCat}
                  onValueChange={(v) => setSelectedCat(v as CategoryVal)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        <div className="flex items-center gap-2">
                          <c.icon className="h-4 w-4" /> {c.label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Uploader Filter */}
              <div className="flex items-center gap-2 flex-1">
                <UserIcon className="h-4 w-4 text-gray-500" />
                <Select
                  value={selectedUploader}
                  onValueChange={(v) => setSelectedUploader(v)}
                  disabled={loadingUploaders}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Uploader" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      <div className="flex items-center gap-2">
                        <UserIcon className="h-4 w-4" /> All Uploaders
                      </div>
                    </SelectItem>
                    {uploaders.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>

        {/* ── Welcome / Count ─────────────────────── */}
        <div className="px-4 py-4 bg-rose-50 border-b">
          <p className="text-center text-gray-700">
            Welcome,&nbsp;
            <span className="font-semibold text-rose-700">{userName}</span>!
            <br />
            <span className="text-sm text-gray-600">
              {photosCount} {selectedCat !== "all" ? `${selectedCat} ` : ""}
              photo{photosCount === 1 ? "" : "s"}
              {selectedUploader !== "all" && (
                <>
                  {" "}
                  by <span className="font-medium">{selectedUploader}</span>
                </>
              )}
            </span>
          </p>
        </div>

        {/* ── Grid ────────────────────────── */}
        <div className="p-4">
          {photos.length === 0 && !isValidating ? (
            <p className="text-center text-gray-500 pt-10">No photos yet</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {photos.map((ph) => (
                <PhotoCard
                  key={ph.id}
                  photo={ph}
                  isOwner={ph.uploader === userName}
                  onUpdated={() => mutate()}
                  onDeleted={() => {
                    mutate()
                    setPhotosCount((c) => Math.max(0, c - 1))
                  }}
                />
              ))}
            </div>
          )}

          {/* Sentinel */}
          <div
            ref={sentinel}
            className={clsx("h-10", isValidating && "animate-pulse")}
          />
        </div>

        {/* ── Floating Upload Button ──────── */}
        <Button
          onClick={() => router.push("/upload")}
          className="bg-rose-600 hover:bg-rose-700 text-white rounded-full shadow-lg fixed bottom-6 right-6 h-16 w-16"
        >
          <Upload className="h-12 w-12 text-white" />
        </Button>
      </div>
    </>
  )
}
