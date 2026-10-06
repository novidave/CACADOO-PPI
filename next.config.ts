import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Logos are shrunk in the browser first; this leaves room for the form's own overhead.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
