import createComponentClient from "@/lib/supabase/createComponentClient"
import { User } from "@supabase/supabase-js"
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "next/router"

export type UserReal = User & {
  name: string
}

export function useUser(serverUser: User | null = null) {
  const supabase = createComponentClient()
  const router = useRouter()
  const {
    isPending,
    isLoading,
    error,
    data: user,
    refetch,
  } = useQuery<UserReal | null>({
    queryKey: ["user"],
    queryFn: async () => {
      const sessionUser =
        serverUser || (await supabase.auth.getUser()).data?.user
      console.log("sessionUser", sessionUser)

      // get name from local storage
      const name = localStorage.getItem("userName")
      if (name && sessionUser) {
        return {
          ...sessionUser,
          name,
        }
      }

      return null
    },
  })
  return {
    user: (user || null) as UserReal | null,
    isPending,
    isLoading,
    error,
    refetchUser: refetch,
  }
}
