"use client";

import dynamic from "next/dynamic";

// Their code is not part of the page's first JavaScript: loaded after the page, they still read the browser's
// buffered measurements (LCP, CLS, INP).
const SpeedInsights = dynamic(() => import("@vercel/speed-insights/next").then((m) => m.SpeedInsights), { ssr: false });
const Analytics = dynamic(() => import("@vercel/analytics/next").then((m) => m.Analytics), { ssr: false });

/**
 * Vercel Speed Insights and Web Analytics (performance pass): cookie-free, no ads, no location (privacy page).
 * Rendered by the root layouts only on Vercel (process.env.VERCEL), where their scripts exist.
 */
export function VercelMetrics() {
  return (
    <>
      <SpeedInsights />
      <Analytics />
    </>
  );
}
