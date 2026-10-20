"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { facebookImportState } from "@/app/[lang]/(account)/dashboard/blog/actions";

/** "Sťahujem príspevky… zatiaľ 50": asks every 3 seconds while the import runs, then reloads the list. */
export function FacebookImportProgress({
  shopId,
  initial,
  labels,
}: {
  shopId: string;
  initial: { state: string; count: number; error: string | null };
  labels: { fb_import_running: string; fb_import_done: string; fb_import_failed: string };
}) {
  const router = useRouter();
  const [now, setNow] = useState(initial);

  useEffect(() => {
    if (now.state !== "running") return;
    const timer = window.setTimeout(async () => {
      const next = await facebookImportState({ shopId }).catch(() => null);
      if (!next) return;
      setNow(next);
      if (next.state !== "running") router.refresh();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [now, shopId, router]);

  const text =
    now.state === "running"
      ? labels.fb_import_running.replace("{n}", String(now.count))
      : now.state === "done"
        ? labels.fb_import_done.replace("{n}", String(now.count))
        : now.state === "failed"
          ? labels.fb_import_failed.replace("{message}", now.error ?? "")
          : null;
  if (!text) return null;
  return (
    <p role="status" aria-live="polite" className="text-sm" data-import-state={now.state}>
      {text}
    </p>
  );
}
