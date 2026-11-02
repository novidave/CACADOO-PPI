"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** While something waits elsewhere (a QR sale confirmed on the terminal): the page reads itself again every few seconds. */
export function PollRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, Math.max(2, seconds) * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
