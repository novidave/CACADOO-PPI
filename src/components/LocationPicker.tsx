"use client";

import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * Latitude/longitude inputs plus a map: click the map to move the pin.
 * The inputs alone are enough (the map is only a helper).
 */
export function LocationPicker({
  initial,
  labels,
}: {
  initial: { lat: number | null; lng: number | null };
  labels: { lat: string; lng: string; hint: string; map: string };
}) {
  const [lat, setLat] = useState(initial.lat?.toString() ?? "");
  const [lng, setLng] = useState(initial.lng?.toString() ?? "");
  const container = useRef<HTMLDivElement>(null);
  const marker = useRef<import("maplibre-gl").Marker | null>(null);
  const start = useRef(initial);

  useEffect(() => {
    if (!container.current) return;
    let map: import("maplibre-gl").Map | undefined;
    let cancelled = false;
    import("maplibre-gl").then((maplibre) => {
      if (cancelled || !container.current) return;
      maplibre.setWorkerUrl(`/maplibre/${maplibre.getVersion()}/maplibre-gl-worker.mjs`);
      const { lat: la, lng: ln } = start.current;
      const hasPoint = la !== null && ln !== null;
      map = new maplibre.Map({
        container: container.current,
        style: "https://tiles.openfreemap.org/styles/positron",
        // Without a point yet, show Europe.
        center: hasPoint ? [ln!, la!] : [15, 50],
        zoom: hasPoint ? 15 : 3.5,
        attributionControl: { compact: true },
      });
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      const pin = document.createElement("div");
      pin.className = "ppi-pin";
      marker.current = new maplibre.Marker({ element: pin, draggable: true });
      if (hasPoint) marker.current.setLngLat([ln!, la!]).addTo(map);
      const set = (p: { lat: number; lng: number }) => {
        setLat(p.lat.toFixed(6));
        setLng(p.lng.toFixed(6));
      };
      map.on("click", (e) => {
        marker.current!.setLngLat(e.lngLat).addTo(map!);
        set(e.lngLat);
      });
      marker.current.on("dragend", () => set(marker.current!.getLngLat()));
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, []);

  // Typing coordinates moves the pin too.
  useEffect(() => {
    const la = Number(lat);
    const ln = Number(lng);
    if (marker.current && lat !== "" && lng !== "" && Math.abs(la) <= 90 && Math.abs(ln) <= 180) {
      try {
        marker.current.setLngLat([ln, la]);
      } catch {
        // marker not on a map yet
      }
    }
  }, [lat, lng]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm">{labels.lat}</span>
          <input
            name="lat"
            inputMode="decimal"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            className="w-40 rounded border border-line px-3 py-2 tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">{labels.lng}</span>
          <input
            name="lng"
            inputMode="decimal"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            className="w-40 rounded border border-line px-3 py-2 tabular-nums"
          />
        </label>
      </div>
      <p className="text-sm text-muted">{labels.hint}</p>
      <div ref={container} role="region" aria-label={labels.map} className="h-64 w-full border border-line" />
    </div>
  );
}
