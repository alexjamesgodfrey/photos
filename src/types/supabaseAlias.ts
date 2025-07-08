import { Database } from "./supabase"

export type WeddingUploads =
  Database["public"]["Tables"]["wedding_uploads"]["Row"]
