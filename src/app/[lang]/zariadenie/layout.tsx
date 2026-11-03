import type { Metadata } from "next";

// A paired phone's pages (database update 72): private, never indexed or cached.
export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function DeviceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
