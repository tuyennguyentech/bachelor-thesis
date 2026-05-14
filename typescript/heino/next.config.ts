import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["buf"],
  allowedDevOrigins: ["caddy"],
};

export default nextConfig;
