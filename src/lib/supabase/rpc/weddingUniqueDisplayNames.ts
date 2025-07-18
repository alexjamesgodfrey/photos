import { Database } from "@/types/supabase"
import { SupabaseClient } from "@supabase/supabase-js"

export async function weddingUniqueDisplayNames(
  supabase: SupabaseClient<Database>
) {
  const { data, error } = await supabase.rpc("wedding_unique_display_names")

  if (error) throw error

  //   make the @rebeccaoharaphotography first item
  const rebecca = data.find((name) => name === "@rebeccaoharaphotography")
  if (rebecca) {
    data.splice(data.indexOf(rebecca), 1)
    data.unshift(rebecca)
  }

  return data
}
