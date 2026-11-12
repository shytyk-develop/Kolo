import type { NextConfig } from "next";

// /api goes to the backend server-side: same origin for the browser, first-party cookie
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
