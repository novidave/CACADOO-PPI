"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { pairDevice } from "@/app/[lang]/zariadenie/actions";
import type { Locale } from "@/i18n/config";

const subscribe = (f: () => void) => {
  window.addEventListener("hashchange", f);
  return () => window.removeEventListener("hashchange", f);
};
const readHash = () => window.location.hash.replace(/^#/, "");

/**
 * The phone opened the QR code (database update 72): the code is after "#" (never sent to a server by the address),
 * and the phone pairs only when its user taps "Pripojiť toto zariadenie" (a link preview never uses the code up).
 */
export function DevicePairScreen({ lang, labels: L }: { lang: Locale; labels: Record<string, string> }) {
  const router = useRouter();
  const code = useSyncExternalStore(subscribe, readHash, () => "");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const valid = /^skp_[0-9a-f]{64}$/.test(code);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4" data-device-pair>
      <h1 className="text-2xl font-bold">{L.pair_title}</h1>
      <p>{valid ? L.pair_text : L.pair_no_code}</p>
      {error && (
        <p role="alert" className="rounded-xl border border-foreground p-3 font-medium">
          {error === "code" ? L.pair_bad_code : L.pair_failed}
        </p>
      )}
      {valid && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              const res = await pairDevice({ lang, code });
              if (res.ok) {
                window.history.replaceState(null, "", window.location.pathname);
                router.replace(`/${lang}/zariadenie?ok=paired`);
              } else setError(res.error ?? "failed");
            })
          }
          className="inline-flex min-h-12 items-center justify-center rounded-xl bg-foreground px-4 font-bold text-white disabled:opacity-60"
        >
          {busy ? L.pair_busy : L.pair_button}
        </button>
      )}
      <p className="text-[13px] text-muted">{L.pair_private}</p>
    </div>
  );
}
