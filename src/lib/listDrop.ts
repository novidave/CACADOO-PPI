/**
 * The list bubble drops into the assistant's input bar (2026-11-04): a copy of the bubble is thrown in a short arc from
 * where it was pressed and falls onto the list chip with one bounce, ~750 ms; the chip itself appears as it lands
 * (`data-drop`, CSS). Decoration only: `aria-hidden`, no pointer events, removed when done; nothing moves with
 * prefers-reduced-motion. Browser only, no imports.
 */
export function dropBubble(from: Element | null, to: Element | null, text: string): void {
  if (!from || !to || typeof window === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (!a.width || !b.width) return;
  const ball = document.createElement("span");
  ball.className = "ppi-ai-bubble ppi-ai-drop";
  ball.textContent = text;
  ball.setAttribute("aria-hidden", "true");
  Object.assign(ball.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  document.body.append(ball);
  // lands on the chip's left part (where its own bubble sits), vertically centred
  const dx = b.left + 6 - a.left;
  const dy = b.top + (b.height - a.height) / 2 - a.top;
  const peak = Math.min(0, dy) - 56;
  const at = (x: number, y: number, s = 1) => `translate(${x}px, ${y}px) scale(${s})`;
  const motion = ball.animate(
    [
      { transform: at(0, 0), offset: 0, easing: "cubic-bezier(.2,.7,.4,1)" },
      { transform: at(dx * 0.45, peak, 1.08), offset: 0.38, easing: "cubic-bezier(.6,0,.9,.6)" },
      { transform: at(dx, dy, 0.92), offset: 0.72, easing: "ease-out" },
      { transform: at(dx, dy - 12, 1), offset: 0.84, easing: "ease-in" },
      { transform: at(dx, dy, 0.96), offset: 0.94, easing: "ease-out" },
      { transform: at(dx, dy, 1), offset: 1 },
    ],
    { duration: 760, fill: "forwards" },
  );
  const done = () => ball.remove();
  motion.onfinish = done;
  motion.oncancel = done;
  window.setTimeout(done, 1500);
}
