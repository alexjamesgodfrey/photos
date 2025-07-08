import { Database } from "@/types/supabase"
import { createBrowserClient } from "@supabase/ssr"

export default function createComponentClient() {
  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  return supabase
}
