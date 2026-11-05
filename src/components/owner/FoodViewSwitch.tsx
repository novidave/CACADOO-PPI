"use client";

import { useEffect, useSyncExternalStore } from "react";
import { FOOD_VIEW_KEY } from "@/lib/foodFeed";

/**
 * Objednávky jedla → "Feed | Stĺpce" (database update 81): the feed or the kitchen board, remembered per device
 * (localStorage `ppi.food.view`, try/catch). The choice lives on <html data-food-view> — FOOD_VIEW_BOOT sets it before
 * the first paint (@/lib/foodFeed), so the page never flashes the other view; the CSS in globals.css shows one. Real links (`?view=`)
 * work without JavaScript; with it a tap only switches the attribute (no navigation). Hidden on a phone (only the feed).
 */

type View = "feed" | "columns";

function subscribe(change: () => void) {
  const observer = new MutationObserver(change);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-food-view"] });
  return () => observer.disconnect();
}

export function FoodViewSwitch({ initial, labels, hrefs }: { initial: View; labels: { label: string; feed: string; columns: string }; hrefs: Record<View, string> }) {
  const view = useSyncExternalStore(
    subscribe,
    () => (document.documentElement.getAttribute("data-food-view") === "columns" ? "columns" : "feed") as View,
    () => initial,
  );
  // a client navigation does not run the page's inline script: the device's choice is put on <html> here then
  useEffect(() => {
    if (document.documentElement.hasAttribute("data-food-view")) return;
    try {
      const stored = window.localStorage.getItem(FOOD_VIEW_KEY);
      if (stored === "columns" || stored === "feed") document.documentElement.setAttribute("data-food-view", stored);
    } catch {
      // blocked storage: the feed
    }
  }, []);
  const choose = (next: View) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    document.documentElement.setAttribute("data-food-view", next);
    try {
      window.localStorage.setItem(FOOD_VIEW_KEY, next);
    } catch {
      // blocked storage: only for this visit
    }
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.replaceState(window.history.state, "", url);
  };
  return (
    <nav aria-label={labels.label} className="hidden rounded-xl bg-[#EEF1F5] p-1 lg:inline-flex" data-food-view-switch>
      {(["feed", "columns"] as const).map((v) => (
        <a
          key={v}
          href={hrefs[v]}
          onClick={choose(v)}
          aria-current={view === v ? "page" : undefined}
          className={`flex min-h-11 items-center rounded-lg px-4 font-semibold ${view === v ? "bg-white shadow-sm" : "text-muted"}`}
          data-food-view-link={v}
        >
          {v === "feed" ? labels.feed : labels.columns}
        </a>
      ))}
    </nav>
  );
}
