import type { NextConfig } from "next";

// /api goes to the backend server-side: same origin for the browser, first-party cookie
const BACKEND_URL = (process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/+$/, "");

// for every response; the CSP with a nonce comes from src/proxy.ts
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // don't leak the page we come from (room code in the path)
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // -allow-popups: we must be able to close the Telegram window we open ourselves
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(self), microphone=(self), display-capture=(self), autoplay=(self), fullscreen=(self), " +
      "geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // small docker image (ch18)
  output: "standalone",
  // no cacheComponents: it keeps left pages alive and reruns their effects on Back,
  // so the call page would rejoin with an old ticket
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
};

export default nextConfig;
