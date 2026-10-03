"use client";

import { useEffect, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

export interface MapShop {
  slug: string;
  name: string;
  lat: number;
  lng: number;
  href: string;
}

/**
 * Black-and-white map of shops (OpenFreeMap "positron" tiles: free, no API key,
 * commercial use allowed). Purely an extra: every page works without it.
 * Tapping a pin marks that shop's results (elements with data-shop="<slug>").
 */
export function ShopMap({
  shops,
  visitor,
  label,
  className = "h-64 md:h-96",
}: {
  shops: MapShop[];
  visitor?: { lat: number; lng: number } | null;
  label: string;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
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

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [key]);

  if (shops.length === 0) return null;
  return <div ref={container} role="region" aria-label={label} className={`w-full border border-line ${className}`} />;
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
