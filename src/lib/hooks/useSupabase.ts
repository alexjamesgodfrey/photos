import { useUser } from "@/lib/hooks/useUser"
import createComponentClient from "@/lib/supabase/createComponentClient"
import { Database } from "@/types/supabase"
import { SupabaseClient } from "@supabase/supabase-js"
import { useEffect, useState } from "react"

export function useSupabase() {
  const { user } = useUser()
  const [client, setClient] = useState<SupabaseClient<Database>>(
    createComponentClient()
  )
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    try {
      const newClient = createComponentClient()
      setClient(newClient)
      setError(null)
    } catch (err) {
      setError(
        err instanceof Error
          ? err
          : new Error("Failed to create Supabase client")
      )
    }
  }, [user?.id]) // Only recreate client when user ID changes

  return {
    supabase: client,
    error,
    isInitialized: Boolean(client),
  }
}

export function useSupabaseOrThrow() {
  const { supabase, error, isInitialized } = useSupabase()

  if (supabase === null) {
    throw new Error("Supabase client not initialized")
  }

  if (error) {
    throw error
  }

  if (!isInitialized) {
    throw new Error("Supabase client not initialized")
  }

  return supabase
}
