"use client";

import { useState } from "react";

/**
 * Asks the browser for the visitor's position and reloads the search with it.
 * Rounded to ~100 m: enough to sort shops by distance, less precise than GPS.
 */
export function LocateButton({
  label,
  locatingLabel,
  failedLabel,
}: {
  label: string;
  locatingLabel: string;
  failedLabel: string;
}) {
  const [state, setState] = useState<"idle" | "locating" | "failed">("idle");

  function locate() {
    if (!("geolocation" in navigator)) {
      setState("failed");
      return;
    }
    setState("locating");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const url = new URL(window.location.href);
        url.searchParams.set("lat", position.coords.latitude.toFixed(3));
        url.searchParams.set("lng", position.coords.longitude.toFixed(3));
        window.location.assign(url.toString());
      },
      () => setState("failed"),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={locate}
        disabled={state === "locating"}
        className="underline underline-offset-4 disabled:no-underline disabled:text-muted"
      >
        {state === "locating" ? locatingLabel : label}
      </button>
      {state === "failed" && <span className="text-muted">{failedLabel}</span>}
    </span>
  );
}
