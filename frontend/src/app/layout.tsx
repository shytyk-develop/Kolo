import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import { CameraLayer } from "@/components/CameraLayer";
import { MediaProvider } from "@/components/MediaProvider";

import "./globals.css";

// apple devices use SF Pro from the system; everyone else gets Inter, preloaded, no swap jump
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "kolo.",
  description: "Video calls for two. No rooms. No clutter.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
  // safe-area insets for the notch and the home indicator
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <MediaProvider>
          <CameraLayer>{children}</CameraLayer>
        </MediaProvider>
      </body>
    </html>
  );
}
