import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  /* config options here */
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: `vtgxzlvjcqqgxcaoiamy.supabase.co`,
        pathname: "/storage/v1/**",
      },
    ],
  },
}

export default nextConfig
