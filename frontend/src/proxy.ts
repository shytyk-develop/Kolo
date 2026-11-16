import { NextRequest, NextResponse } from "next/server";

// where the browser opens its websocket (the pages themselves and /api are same-origin)
const API = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const DEV = process.env.NODE_ENV === "development";
// same as KOLO_PROXY_SECRET on the backend: how it knows the request really came from here
const PROXY_SECRET = process.env.KOLO_PROXY_SECRET ?? "";

function contentSecurityPolicy(nonce: string): string {
  const api = [API, API.replace(/^http/, "ws")].join(" ");
  return [
    "default-src 'self'",
    // only our own scripts, each with this response's nonce; dev needs eval for React
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${DEV ? " 'unsafe-eval'" : ""}`,
    // style="" on elements (animations) doesn't work with a nonce
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "font-src 'self'",
    `connect-src 'self' ${api}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(DEV ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const headers = new Headers(request.headers);
    // one sent from outside doesn't count
    headers.delete("x-kolo-proxy");
    if (PROXY_SECRET) headers.set("x-kolo-proxy", PROXY_SECRET);
    return NextResponse.next({ request: { headers } });
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  // next reads the nonce from here and puts it on its own scripts
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
