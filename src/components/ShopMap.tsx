"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { StatusLabels } from "@/lib/hours";
import type { MapShop } from "./ShopMapCanvas";

export type { MapShop } from "./ShopMapCanvas";

// maplibre (≈ 280 kB) and its CSS load only with the canvas, never with the page.
const ShopMapCanvas = dynamic(() => import("./ShopMapCanvas").then((m) => m.ShopMapCanvas), { ssr: false });

/**
 * The map's place on the page: a plain light box of the map's exact size first (nothing moves when the map comes),
 * then the interactive map — when the box comes into view, the page has loaded and the browser is idle, or at once when it is tapped or
 * focused. Purely an extra: every page works and shows its data without it.
 */
export function ShopMap({
  shops,
  visitor,
  label,
  className = "h-64 md:h-96",
  statusLabels,
  renderedAt = 0,
}: {
  shops: MapShop[];
  visitor?: { lat: number; lng: number } | null;
  label: string;
  className?: string;
  /** The status words for the pins' tooltips (namespace "status"). */
  statusLabels?: StatusLabels;
  /** Date.now() on the server (the first render of the colours). */
  renderedAt?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (live || !box.current) return;
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let soon: (() => void) | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        const go = () => setLive(true);
        // After the page itself (fonts, pictures) has loaded: the map's code never competes with the first view.
        soon = () => {
          if ("requestIdleCallback" in window) idle = window.requestIdleCallback(go, { timeout: 2500 });
          else timer = setTimeout(go, 1200);
        };
        if (document.readyState === "complete") soon();
        else window.addEventListener("load", soon, { once: true });
      },
      { rootMargin: "200px" },
    );
    observer.observe(box.current);
    return () => {
      observer.disconnect();
      if (soon) window.removeEventListener("load", soon);
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
