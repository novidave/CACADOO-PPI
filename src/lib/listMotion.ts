/**
 * The shopping list's small movements (2026-10-29, at the owner's request): a ball that jumps from one element to
 * another, a pop, a wiggle, a shake, a dip. Web Animations only (nothing to load, nothing left behind). With
 * `prefers-reduced-motion` nothing moves: every function returns at once, the state changes are instant.
 */

export const reducedMotion = () => typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const center = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/**
 * A 12 px ball in `color` jumps in an arc from `from` to `to` (~820 ms) and bounces once where it lands. Resolves when
 * it has landed (at once with reduced motion or when an element is gone).
 */
export function flyBall(from: Element | null, to: Element | null, color: string, duration = 820): Promise<void> {
  if (!from || !to || reducedMotion()) return Promise.resolve();
  const a = center(from);
  const b = center(to);
  const size = 12;
  const ball = document.createElement("span");
  ball.setAttribute("aria-hidden", "true");
  Object.assign(ball.style, {
    position: "fixed",
    left: `${a.x - size / 2}px`,
    top: `${a.y - size / 2}px`,
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: "50%",
    background: color,
    zIndex: "60",
    pointerEvents: "none",
  });
  document.body.appendChild(ball);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // The arc's height grows with the distance, always above both ends.
  const lift = Math.min(160, 60 + Math.hypot(dx, dy) * 0.25);
  const steps = 16;
  const flight = 0.82; // the rest is the bounce
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in-out along the way
    const x = dx * e;
    const y = dy * e - lift * 4 * e * (1 - e);
    frames.push({ offset: t * flight, transform: `translate(${x}px, ${y}px) scale(${1 - 0.25 * t})` });
  }
  frames.push({ offset: flight + (1 - flight) * 0.5, transform: `translate(${dx}px, ${dy - 8}px) scale(0.75)` });
  frames.push({ offset: 1, transform: `translate(${dx}px, ${dy}px) scale(0.7)`, opacity: 0 });
  const run = ball.animate(frames, { duration, easing: "linear", fill: "forwards" });
  return run.finished.then(
    () => ball.remove(),
    () => ball.remove(),
  );
}

const play = (el: Element | null, frames: Keyframe[], duration: number) => {
  if (!el || reducedMotion()) return;
  el.animate(frames, { duration, easing: "ease-out" });
};

/** A counter that changed: a quick pop. */
export const pop = (el: Element | null) =>
  play(el, [{ transform: "scale(1)" }, { transform: "scale(1.35)" }, { transform: "scale(1)" }], 320);

/** The list icon after an add: a wiggle. */
export const wiggle = (el: Element | null) =>
  play(el, [{ transform: "rotate(0)" }, { transform: "rotate(-14deg)" }, { transform: "rotate(10deg)" }, { transform: "rotate(-6deg)" }, { transform: "rotate(0)" }], 420);

/** The list icon after a removal: a shake. */
export const shake = (el: Element | null) =>
  play(el, [{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }], 380);

/** A counter that went down: it dips with a brief orange flash. */
export const dip = (el: Element | null) =>
  play(
    el,
    [
      { transform: "translateY(0) scale(1)" },
      { transform: "translateY(3px) scale(0.85)", backgroundColor: "#F97316", offset: 0.4 },
      { transform: "translateY(0) scale(1)" },
    ],
    380,
  );
