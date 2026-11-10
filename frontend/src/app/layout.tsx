import type { Metadata, Viewport } from "next";

import { MediaProvider } from "@/components/MediaProvider";

import "./globals.css";

export const metadata: Metadata = {
  title: "kolo.",
  description: "Video calls for two. No rooms. No clutter.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <MediaProvider>{children}</MediaProvider>
      </body>
    </html>
  );
}
