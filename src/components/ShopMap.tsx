"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { StatusLabels } from "@/lib/hours";
import type { MapShop } from "./ShopMapCanvas";

export type { MapShop } from "./ShopMapCanvas";

// maplibre (≈ 280 kB) and its CSS load only with the canvas, never with the page.
const ShopMapCanvas = dynamic(() => import("./ShopMapCanvas").then((m) => m.ShopMapCanvas), { ssr: false });

// The visitor's first scroll, touch, key or mouse move on this page (remembered for maps that mount later, e.g. the
// chat's "Zobraziť mapu"). MapLibre blocks a slow phone's main thread for most of a second while it starts, so it
// never starts before that: never during the first view, never in the way of the first tap.
const ENGAGE = ["pointerdown", "touchstart", "keydown", "wheel", "scroll", "mousemove"] as const;
let engaged = false;
const waiting = new Set<() => void>();
function onEngage() {
  engaged = true;
  for (const e of ENGAGE) window.removeEventListener(e, onEngage, true);
  for (const run of waiting) run();
  waiting.clear();
}
if (typeof window !== "undefined") for (const e of ENGAGE) window.addEventListener(e, onEngage, { capture: true, passive: true });

/**
 * The map's place on the page: a plain light box of the map's exact size first (nothing moves when the map comes),
 * then the interactive map — near the screen after the visitor's first scroll, touch or key (when the browser is
 * idle), or at once when it is tapped or focused. Purely an extra: every page works and shows its data without it.
 */
export function ShopMap({
  shops,
  visitor,
  label,
  className = "h-64 md:h-96",
  statusLabels,
  renderedAt = 0,
  opened = false,
}: {
  shops: MapShop[];
  visitor?: { lat: number; lng: number } | null;
  label: string;
  className?: string;
  /** The status words for the pins' tooltips (namespace "status"). */
  statusLabels?: StatusLabels;
  /** Date.now() on the server (the first render of the colours). */
  renderedAt?: number;
  /** Opened by a tap (the chat's "Zobraziť mapu"): the map starts at once. */
  opened?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(opened);

  useEffect(() => {
    if (live || !box.current) return;
    // Near the screen and after the visitor's first interaction (above), in an idle moment; a tap on the box: at once.
    let seen = false;
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => setLive(true);
    const maybe = () => {
      if (!seen || idle !== undefined || timer !== undefined) return;
      if (!engaged) {
        waiting.add(maybe);
        return;
      }
      if ("requestIdleCallback" in window) idle = window.requestIdleCallback(go, { timeout: 2500 });
      else timer = setTimeout(go, 300);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        seen = entries.some((e) => e.isIntersecting);
        maybe();
      },
      { rootMargin: "200px" },
    );
    observer.observe(box.current);
    return () => {
      observer.disconnect();
      waiting.delete(maybe);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer) clearTimeout(timer);
    };
  }, [live]);

  if (shops.length === 0) return null;
  return (
    <div
      ref={box}
      role="region"
      aria-label={label}
      className={`ppi-map-box relative w-full border border-line ${className}`}
      onPointerDown={() => setLive(true)}
      onFocus={() => setLive(true)}
      data-map={live ? "live" : "waiting"}
    >
      {live && (
        <ShopMapCanvas shops={shops} visitor={visitor} label={label} className="h-full" statusLabels={statusLabels} renderedAt={renderedAt} />
      )}
    </div>
  );
}
