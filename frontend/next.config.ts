import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // small docker image (ch18)
  output: "standalone",
  // no cacheComponents: it keeps left pages alive and reruns their effects on Back,
  // so the call page would rejoin with an old ticket
};

export default nextConfig;
