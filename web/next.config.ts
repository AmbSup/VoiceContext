import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse loads pdfjs-dist and its native @napi-rs/canvas polyfills at
  // runtime. Bundling it into a Turbopack server chunk prevents Vercel's
  // output tracer from shipping the native Canvas package, leaving
  // DOMMatrix undefined as soon as the Capture action module is evaluated.
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],
  experimental: {
    serverActions: { bodySizeLimit: "5mb" },
  },
};

export default nextConfig;
