import type { NextConfig } from "next";

// where /api goes, server side only: the browser talks to our own origin, so the
// Telegram cookie is first-party. Falls back to the public url, then local dev
const BACKEND_URL = (process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // small docker image (ch18)
  output: "standalone",
  // no cacheComponents: it keeps left pages alive and reruns their effects on Back,
  // so the call page would rejoin with an old ticket
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
};

export default nextConfig;
