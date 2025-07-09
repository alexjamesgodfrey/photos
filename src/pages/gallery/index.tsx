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

  /* ---------- 1.  Auth guard & user name ---------- */
  useEffect(() => {
    const name = localStorage.getItem("userName")
    if (!name) {
      router.push("/")
      return
    }
    setUserName(name)
  }, [router])

  /* ---------- 2.  SWR infinite ---------- */
  const getKey = (index: number, prev: WeddingUploads[] | null) => {
    if (prev && !prev.length) return null // reached end
    return { index, cat: selectedCat }
  }

  const fetcher = async (key: { index: number; cat: CategoryVal }) => {
    const from = key.index * PAGE_SIZE
    const to = from + PAGE_SIZE - 1

    let q = supabase
      .from("wedding_uploads")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, to)

    if (key.cat !== "all") q = q.eq("category", key.cat)

    const { data, error } = await q
    if (error) throw error
    return data as WeddingUploads[]
  }

  const { data, size, setSize, isValidating, mutate } = useSWRInfinite<
    WeddingUploads[]
  >(getKey, fetcher, { revalidateOnFocus: false })

  /* ---------- 3.  Map DB rows to UI objects ---------- */
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

  /* ---------- 4.  Infinite scroll sentinel ---------- */
  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!sentinel.current) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setSize((s) => s + 1)
      },
      { rootMargin: "100px" }
    )
    io.observe(sentinel.current)
    return () => io.disconnect()
  }, [setSize])

  /* ---------- 5.  Realtime new-photo subscription ---------- */
  useEffect(() => {
    const channel = supabase
      .channel("rt-uploads")
      .on<WeddingUploads>(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "wedding_uploads" },
        (payload: RealtimePostgresInsertPayload<WeddingUploads>) => {
          const newRow = payload.new // ← *typed* DbRow

          mutate<WeddingUploads[][]>(
            (pages) => {
              if (!pages) return [[newRow]] // cache empty → first page
              return [
                [newRow, ...pages[0]], // prepend immutably
                ...pages.slice(1),
              ]
            },
            false // don’t revalidate network
          )
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [mutate, selectedCat, supabase])

  /* ---------- 6.  Helpers ---------- */
  const CatIcon = (cat: CategoryVal) =>
    categories.find((c) => c.value === cat)?.icon ?? Camera

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

        {/* Page-specific Open Graph */}
        <meta
          property="og:title"
          content="Wedding Gallery - Alex & Sierra's Wedding"
        />
        <meta
          property="og:description"
          content="Browse and view all the special moments from Alex & Sierra's wedding celebration."
        />
        <meta property="og:image" content="/cover-photo.png" />

        {/* Page-specific Twitter */}
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

            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-gray-500" />
              <Select
                value={selectedCat}
                onValueChange={(v) => {
                  setSelectedCat(v as CategoryVal)
                  setSize(1)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
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
          </div>
        </div>

        {/* ── Welcome ─────────────────────── */}
        <div className="px-4 py-4 bg-rose-50 border-b">
          <p className="text-center text-gray-700">
            Welcome,&nbsp;
            <span className="font-semibold text-rose-700">{userName}</span>!
            <br />
            <span className="text-sm text-gray-600">
              {photos.length} photo{photos.length === 1 ? "" : "s"} shared by
              the wedding party
            </span>
          </p>
        </div>

        {/* ── Grid ────────────────────────── */}
        <div className="p-4">
          {photos.length === 0 && !isValidating ? (
            <p className="text-center text-gray-500 pt-10">No photos yet</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {photos.map((ph) => {
                return (
                  <PhotoCard
                    key={ph.id}
                    photo={ph}
                    isOwner={ph.uploader === userName}
                    onUpdated={() => mutate()}
                    onDeleted={() => mutate()}
                  />
                )
              })}
            </div>
          )}

          {/* Sentinel for infinite scroll */}
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
