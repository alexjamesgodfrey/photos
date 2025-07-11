"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { categories } from "@/lib/constants" // reuse same list
import { useSupabase } from "@/lib/hooks/useSupabase"
import { Download, MoreVertical, Trash2 } from "lucide-react"
import Image from "next/image"
import { useState } from "react"

export interface PhotoCardProps {
  photo: {
    id: string
    src: string
    fullSrc: string
    uploader: string
    category: string
    timestamp: string
    filePath: string // we’ll pass this so we can delete it
  }
  isOwner: boolean
  onUpdated?: (p: PhotoCardProps["photo"]) => void
  onDeleted?: (id: string) => void
}

export function PhotoCard({
  photo,
  isOwner,
  onUpdated,
  onDeleted,
}: PhotoCardProps) {
  const { supabase } = useSupabase()
  const [busy, setBusy] = useState(false)

  /* ───────── owner actions ───────── */
  const changeCategory = async (cat: string) => {
    if (cat === photo.category) return
    setBusy(true)
    const { error } = await supabase
      .from("wedding_uploads")
      .update({ category: cat })
      .eq("id", photo.id)
      .single()
    setBusy(false)
    if (!error && onUpdated) onUpdated({ ...photo, category: cat })
  }

  const deletePhoto = async () => {
    if (!confirm("Delete this photo permanently?")) return
    setBusy(true)
    await supabase.storage.from("wedding").remove([photo.filePath])
    await supabase.from("wedding_uploads").delete().eq("id", photo.id)
    setBusy(false)
    if (onDeleted) onDeleted(photo.id)
  }

  /* ───────── download helper ──────── */
  const download = async () => {
    const res = await fetch(photo.fullSrc)
    const blob = await res.blob()

    /* 1️⃣ Try Web Share API with a File, so the user may pick “Save Image” */
    if (navigator.canShare?.({ files: [] })) {
      const file = new File(
        [blob],
        photo.fullSrc.split("/").pop() ?? "photo.jpg",
        {
          type: blob.type,
        }
      )
      try {
        await navigator.share({ files: [file], title: "Wedding photo" })
        return // success or user cancelled – either way we’re done
      } catch {
        /* fall through on error/cancel */
      }
    }

    /* 2️⃣ Fallback: trigger a regular download (drops into Files) */
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = photo.fullSrc.split("/").pop() ?? "photo.jpg"
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const getDayString = (timestamp: string) => {
    const dayOfWeek = new Date(timestamp).toLocaleDateString("en-US", {
      weekday: "long",
    })
    const month = new Date(timestamp).toLocaleDateString("en-US", {
      month: "long",
    })
    const day = new Date(timestamp).toLocaleDateString("en-US", {
      day: "numeric",
    })

    if (month === "July" && parseInt(day) <= 12) {
      return `${dayOfWeek}`
    }

    return new Date(timestamp).toLocaleString()
  }

  const CatIcon =
    categories.find((c) => c.value === photo.category)?.icon ?? Download

  return (
    <div className="overflow-hidden rounded-xl shadow-sm relative text-black">
      <div className="relative aspect-[3/4] bg-gray-100">
        <Image
          src={photo.fullSrc}
          alt={`Photo by ${photo.uploader}`}
          fill
          sizes="(max-width:640px) 50vw, (max-width:1024px) 33vw, 25vw"
          className="object-cover"
          placeholder="empty"
        />
        {/* badge */}
        <div className="absolute top-2 right-2">
          <Badge variant="secondary" className="text-xs">
            <CatIcon className="h-3 w-3 mr-1" /> {photo.category}
          </Badge>
        </div>
      </div>

      <div className="p-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{photo.uploader}</p>
          <p className="text-xs text-gray-500 truncate">
            {getDayString(photo.timestamp)}
          </p>
        </div>

        {/* action menu */}
        {!isOwner ? (
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            onClick={download}
          >
            <Download className="h-4 w-4" />
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" disabled={busy}>
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={download}>
                <Download className="h-4 w-4 mr-2" /> Save
              </DropdownMenuItem>

              {isOwner && (
                <>
                  <DropdownMenuSeparator />
                  {categories
                    .filter((c) => c.value !== photo.category)
                    .map((c) => (
                      <DropdownMenuItem
                        key={c.value}
                        onClick={() => changeCategory(c.value)}
                      >
                        <c.icon className="h-4 w-4 mr-2" /> {c.label}
                      </DropdownMenuItem>
                    ))}

                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600 focus:text-red-600"
                    onClick={deletePhoto}
                  >
                    <Trash2 className="h-4 w-4 mr-2" /> Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}
