import { SupabaseClient } from "@supabase/supabase-js"

export async function getAccessTokenFromSupabase(supabase: SupabaseClient) {
  const { data: session } = await supabase.auth.getSession()
  if (!session.session?.access_token) {
    throw new Error("No access token")
  }
  return session.session.access_token
}
