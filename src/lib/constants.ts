import { Cake, Camera, GlobeIcon, Heart, Users } from "lucide-react"

export const categories = [
  { value: "all", label: "All Photos", icon: GlobeIcon },
  { value: "professional", label: "Professional", icon: Camera },
  { value: "ceremony", label: "Ceremony", icon: Heart },
  { value: "reception", label: "Reception", icon: Cake },
  { value: "candid", label: "Candid", icon: Users },
] as const
