import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Production container output: Next traces the minimal server + node_modules into
  // .next/standalone (run with `node server.js`). This is the official, smallest
  // way to ship Next.js in Docker — no pnpm/devDeps at runtime. Dev mode ignores it.
  output: "standalone",
  // pnpm monorepo (lockfile at the repo root): pin the trace root to the repo root
  // so standalone bundles the workspace `buf` package correctly. process.cwd() is
  // the heino package dir during build → ../.. is the repo root.
  outputFileTracingRoot: path.join(process.cwd(), "..", ".."),
  transpilePackages: ["buf"],
  allowedDevOrigins: ["caddy"],
};

export default nextConfig;
