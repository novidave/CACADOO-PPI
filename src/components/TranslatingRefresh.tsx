"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** While a shop is being translated ("Prekladáme…"): the page looks again once, 20 s later (only in this tab). */
export function TranslatingRefresh() {
  const router = useRouter();
  useEffect(() => {
    let key = "";
    try {
      key = `ppi.translating.${location.pathname}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // without storage: still once per page view
    }
    const timer = setTimeout(() => router.refresh(), 20_000);
    return () => clearTimeout(timer);
  }, [router]);
  return null;
}
