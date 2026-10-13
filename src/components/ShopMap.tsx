"use client";

import { useEffect, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { shopStatus, STATUS_COLORS, type StatusInput } from "@/lib/hours";
import { type LegendLabels, StatusLegend, useNow } from "./ShopStatus";

export interface MapShop {
  slug: string;
  name: string;
  lat: number;
  lng: number;
  href: string;
  /** The shop's status dot (open / break / closed / holiday / no hours), refreshed every minute. */
  status?: StatusInput;
}

/**
 * Black-and-white map of shops (OpenFreeMap "positron" tiles: free, no API key,
 * commercial use allowed). Purely an extra: every page works without it.
 * Tapping a pin marks that shop's results (elements with data-shop="<slug>").
 * With statuses, each pin is the shop's status colour (white outline, thin dark ring) and the
 * legend in words is under the map; the colours follow the clock every minute.
 */
export function ShopMap({
  shops,
  visitor,
  label,
  className = "h-64 md:h-96",
  legend,
  renderedAt = 0,
}: {
  shops: MapShop[];
  visitor?: { lat: number; lng: number } | null;
  label: string;
  className?: string;
  legend?: LegendLabels;
  /** Date.now() on the server (the first render of the colours). */
  renderedAt?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const pins = useRef(new Map<string, HTMLElement>());
  const now = useNow(renderedAt);
  // Re-create the map only when the pins really change.
  const key = JSON.stringify({ shops, visitor });

  useEffect(() => {
    const { shops, visitor } = JSON.parse(key) as { shops: MapShop[]; visitor?: { lat: number; lng: number } | null };
    if (!container.current || shops.length === 0) return;
    let map: import("maplibre-gl").Map | undefined;
    let cancelled = false;

    import("maplibre-gl").then((maplibre) => {
      if (cancelled || !container.current) return;
      // Copied there by scripts/copy-maplibre-worker.mjs (see that file for why).
      maplibre.setWorkerUrl(`/maplibre/${maplibre.getVersion()}/maplibre-gl-worker.mjs`);
      map = new maplibre.Map({
        container: container.current,
        style: "https://tiles.openfreemap.org/styles/positron",
        center: [shops[0].lng, shops[0].lat],
        zoom: 14,
        attributionControl: { compact: true },
        cooperativeGestures: true, // one finger scrolls the page, two move the map
      });
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");

      const bounds = new maplibre.LngLatBounds();
      for (const shop of shops) {
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "ppi-pin";
        pin.title = shop.name;
        pin.setAttribute("aria-label", shop.name);
        pin.dataset.pin = shop.slug;
        if (shop.status) paint(pin, shop.status, Date.now());
        pins.current.set(shop.slug, pin);
        pin.addEventListener("click", () => highlight(shop.slug));

        const popup = new maplibre.Popup({ offset: 12, closeButton: false }).setDOMContent(popupContent(shop));
        new maplibre.Marker({ element: pin }).setLngLat([shop.lng, shop.lat]).setPopup(popup).addTo(map);
        bounds.extend([shop.lng, shop.lat]);
      }
      if (visitor) {
        const me = document.createElement("div");
        me.className = "ppi-pin-visitor";
        new maplibre.Marker({ element: me }).setLngLat([visitor.lng, visitor.lat]).addTo(map);
        bounds.extend([visitor.lng, visitor.lat]);
      }
      if (shops.length > 1 || visitor) map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
    });

    const known = pins.current;
    return () => {
      cancelled = true;
      known.clear();
      map?.remove();
    };
  }, [key]);

  // Every minute (and right after load): the pins' colours follow the clock.
  useEffect(() => {
    for (const shop of shops) {
      const pin = pins.current.get(shop.slug);
      if (pin && shop.status) paint(pin, shop.status, now);
    }
  }, [now, shops]);

  if (shops.length === 0) return null;
  const withStatus = Boolean(legend) && shops.some((s) => s.status);
  return (
    <div className="flex flex-col gap-2">
      <div ref={container} role="region" aria-label={label} className={`w-full border border-line ${className}`} />
      {withStatus && legend && <StatusLegend labels={legend} />}
    </div>
  );
}

/** The pin in the shop's status colour (the status in words is always next to it on the page). */
function paint(pin: HTMLElement, status: StatusInput, now: number) {
  const state = shopStatus(status, new Date(now)).state;
  pin.style.background = STATUS_COLORS[state];
  pin.dataset.status = state;
}

function popupContent(shop: MapShop): HTMLElement {
  const link = document.createElement("a");
  link.href = shop.href;
  link.textContent = shop.name;
  link.className = "font-medium underline underline-offset-4";
  return link;
}

/** Mark one shop's rows in the result list and bring the first into view. */
function highlight(slug: string) {
  const rows = document.querySelectorAll<HTMLElement>("[data-shop]");
  let first: HTMLElement | null = null;
  rows.forEach((row) => {
    const match = row.dataset.shop === slug;
    row.toggleAttribute("data-highlight", match);
    if (match && !first) first = row;
  });
  (first as HTMLElement | null)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
