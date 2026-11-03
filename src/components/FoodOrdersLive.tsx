"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Asistent → Objednávky (database update 74): while the page is open it asks every 15 s whether a new order came
 * (/api/owner/food/tab — the owner's own login; only a count and a time) and then draws the page again; with "Zvuk"
 * on it plays a short tone (Web Audio — no file, no library; a browser allows sound only after the first tap on the
 * page, so the button also unlocks it). The choice stays in this browser (localStorage, try/catch). Announced in an
 * aria-live region.
 */
export function FoodOrdersLive({
  shopId,
  latest,
  soundDefault,
  labels,
}: {
  shopId: string;
  latest: string | null;
  soundDefault: boolean;
  labels: { on: string; off: string; arrived: string };
}) {
  const router = useRouter();
  const seen = useRef(latest);
  const audio = useRef<AudioContext | null>(null);
  const key = `ppi.food.sound.${shopId}`;
  // the browser's own choice (localStorage; blocked storage → only for this visit)
  const stored = useSyncExternalStore(subscribeSound, () => readSound(key), () => null);
  const [local, setLocal] = useState<boolean | null>(null);
  const sound = local ?? (stored === null ? soundDefault : stored === "1");
  const [said, setSaid] = useState("");
  const soundRef = useRef(sound);
  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);

  useEffect(() => {
    seen.current = latest;
  }, [latest]);

  useEffect(() => {
    const unlock = () => {
      if (!audio.current) {
        try {
          audio.current = new AudioContext();
        } catch {
          audio.current = null;
        }
      }
      void audio.current?.resume();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/owner/food/tab?shop=${encodeURIComponent(shopId)}`, { cache: "no-store" });
        if (!res.ok || stopped) return;
        const data = (await res.json()) as { latest?: string | null };
        const now = data.latest ?? null;
        if (now && now !== seen.current) {
          const fresh = seen.current === null || Date.parse(now) > Date.parse(seen.current);
          seen.current = now;
          if (fresh) {
            setSaid(labels.arrived);
            if (soundRef.current) beep(audio.current);
          }
          router.refresh();
        }
      } catch {
        // offline for a moment: the next tick tries again
      }
    };
    const timer = window.setInterval(tick, 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [router, shopId, labels.arrived]);

  const toggle = () => {
    const next = !sound;
    setLocal(next);
    try {
      window.localStorage.setItem(key, next ? "1" : "0");
      window.dispatchEvent(new Event(SOUND_EVENT));
    } catch {
      // blocked storage: only for this visit
    }
    if (next) beep(audio.current);
  };

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={sound}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm font-semibold"
        data-food-sound={sound ? "on" : "off"}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4V5Z" />
          {sound ? <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /> : <path d="m16 9 5 6M21 9l-5 6" />}
        </svg>
        {sound ? labels.on : labels.off}
      </button>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </>
  );
}

const SOUND_EVENT = "ppi:food-sound";

function subscribeSound(change: () => void) {
  window.addEventListener("storage", change);
  window.addEventListener(SOUND_EVENT, change);
  return () => {
    window.removeEventListener("storage", change);
    window.removeEventListener(SOUND_EVENT, change);
  };
}

function readSound(key: string): string | null {
  try {
    const v = window.localStorage.getItem(key);
    return v === "1" || v === "0" ? v : null;
  } catch {
    return null;
  }
}

/** Two short tones (a kitchen bell, quietly). */
function beep(ctx: AudioContext | null) {
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    for (const [at, freq] of [
      [0, 880],
      [0.22, 1175],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.22);
    }
  } catch {
    // no sound on this device
  }
}
