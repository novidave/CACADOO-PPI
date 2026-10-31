import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Logos are shrunk in the browser first; this leaves room for the form's own overhead.
    serverActions: { bodySizeLimit: "2mb" },
  },
  async headers() {
    return [
      {
        // The page where an owner allows an AI assistant (update 61) never shows inside another site's frame.
        source: "/:lang/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
