"use client";

import { useEffect, useRef, useState } from "react";
import type { ZoomLabels } from "./SectionZoomViewer";

type Viewer = typeof import("./SectionZoomViewer").SectionZoomViewer;

/**
 * The full-screen viewer's place on the page (the shop page's "Obsah stránky", the blog's photos): one small listener
 * for links with data-zoom. The viewer itself (SectionZoomViewer: pinch, swipe, ← →, "Pod sebou") is loaded when such
 * a link is first touched, pointed at or focused, and the tapped picture opens as soon as it is there — so it is not
 * part of the page's first JavaScript. Without JavaScript the links open the picture in a new tab.
 */
export function SectionZoom({ labels }: { labels: ZoomLabels }) {
  const [state, setState] = useState<{ Viewer: Viewer; first: HTMLAnchorElement | null } | null>(null);
  const loading = useRef<Promise<Viewer> | null>(null);

  useEffect(() => {
    if (state) return;
    const load = () => (loading.current ??= import("./SectionZoomViewer").then((m) => m.SectionZoomViewer));
    const linkOf = (e: Event) => (e.target as Element | null)?.closest?.<HTMLAnchorElement>("a[data-zoom]") ?? null;
    const warm = (e: Event) => {
      if (linkOf(e)) void load();
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = linkOf(e);
      if (!link) return;
      e.preventDefault();
      void load().then((Viewer) => setState({ Viewer, first: link }));
    };
    document.addEventListener("pointerover", warm, { passive: true });
    document.addEventListener("touchstart", warm, { passive: true });
    document.addEventListener("focusin", warm);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("pointerover", warm);
      document.removeEventListener("touchstart", warm);
      document.removeEventListener("focusin", warm);
      document.removeEventListener("click", onClick);
    };
  }, [state]);

  if (!state) return null;
  return <state.Viewer labels={labels} first={state.first} />;
}
