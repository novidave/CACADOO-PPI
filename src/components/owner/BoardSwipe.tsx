"use client";

import { type ReactNode, useRef, useState } from "react";
import { swipeOutcome } from "@/lib/foodFeed";

/**
 * Objednávky jedla → "Stĺpce" (the kitchen board, 2026-11-05): a card follows the finger sideways like the feed's cards
 * (pointer events, `touch-action: pan-y` — the page still scrolls up and down; never from a button, a link or a field).
 * Past 30 % of its width (swipeOutcome, the feed's own rule) it flies out and the card's OWN step form is sent
 * (requestSubmit: the same server action, the same step UUID as the button — a double swipe is the same step); shorter,
 * it springs back. The pale green layer under it names the step. Only cards whose next step is a plain step get it (a
 * finishing step needs the payment on the order's page). Without JavaScript or with `prefers-reduced-motion` the button
 * does the same.
 */
export function BoardSwipe({ label, children }: { label: string; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  const grab = useRef<{ id: number; x0: number; y0: number; w: number; sideways: boolean } | null>(null);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sent, setSent] = useState(false);

  const reset = () => {
    grab.current = null;
    setDragging(false);
    setDx(0);
  };

  return (
    <div className="relative" data-board-swipe>
      <div
        aria-hidden="true"
        className={`absolute inset-0 flex items-center justify-between rounded-xl bg-[#E3F4EA] px-4 text-sm font-bold text-[#146C37] ${dx === 0 && !sent ? "invisible" : ""}`}
      >
        <span>{label}</span>
        <span>{label}</span>
      </div>
      <div
        ref={card}
        className="ppi-feed-card relative"
        style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
        {...(dragging ? { "data-dragging": "" } : {})}
        onPointerDown={(e) => {
          if (sent || e.button !== 0) return;
          if ((e.target as HTMLElement).closest("a, button, input, select, textarea, label")) return;
          grab.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, w: card.current?.offsetWidth ?? 1, sideways: false };
        }}
        onPointerMove={(e) => {
          const g = grab.current;
          if (!g || g.id !== e.pointerId) return;
          const x = e.clientX - g.x0;
          if (!g.sideways) {
            // a vertical move is the page scrolling: let it go
            if (Math.abs(e.clientY - g.y0) > 10 && Math.abs(e.clientY - g.y0) > Math.abs(x)) return reset();
            if (Math.abs(x) < 8) return;
            g.sideways = true;
            card.current?.setPointerCapture(e.pointerId);
            setDragging(true);
          }
          setDx(x);
        }}
        onPointerUp={(e) => {
          const g = grab.current;
          if (!g || g.id !== e.pointerId) return;
          const dir = g.sideways ? swipeOutcome(e.clientX - g.x0, g.w) : 0;
          grab.current = null;
          setDragging(false);
          const form = card.current?.querySelector("form");
          if (dir === 0 || !form) return setDx(0);
          const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          setDx(still ? 0 : dir * (g.w + 40));
          setSent(true);
          // the card's own step form (its hidden fields and step UUID); the page is drawn again by the action
          window.setTimeout(() => form.requestSubmit(), still ? 0 : 230);
        }}
        onPointerCancel={reset}
      >
        {children}
      </div>
    </div>
  );
}
