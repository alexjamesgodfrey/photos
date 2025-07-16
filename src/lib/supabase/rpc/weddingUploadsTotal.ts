import { Database } from "@/types/supabase"
import { SupabaseClient } from "@supabase/supabase-js"

export async function weddingUploadsTotal(
  supabase: SupabaseClient<Database>,
  category?: string
) {
  const { data, error } = await supabase.rpc("wedding_uploads_total", {
    _category: category ?? undefined,
  })

  if (error) throw error

  return data
}
