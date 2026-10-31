"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { holdStep, IDLE, type HoldEvent, type HoldInput, type HoldOpen, type HoldPhase, type HoldState } from "@/lib/holdLink";

type Face = "idle" | "hold" | "done";

// The orange check is shown only after a hold (or a key): its code is not part of the page's first JavaScript; a press
// or the focus fetches it, so it is there when the hold completes.
const loadCheck = () => import("@/components/CheckLoop");
const CheckLoop = lazy(() => loadCheck().then((m) => ({ default: m.CheckLoop })));

/** The point is on the element (a few pixels of slack for a trembling finger). */
function inside(el: Element, x: number, y: number) {
  const r = el.getBoundingClientRect();
  return x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4;
}
const faceOf = (phase: HoldPhase): Face => (phase === "done" ? "done" : phase === "idle" ? "idle" : "hold");


/**
 * A real link (`<a href>`, so it works without JavaScript and for crawlers) that a finger or a mouse opens only after
 * holding it for 1.2 s (`@/lib/holdLink`): the fill grows, "Držte stlačené", then the done label with the orange check
 * and the link opens. A short tap shows "Držte stlačené" for a moment and does nothing. Enter / Space and a screen
 * reader's activation open it at once. No context menu, callout or text selection on a long press. Used by the shop
 * page's contact buttons and "Všetky novinky".
 */
export function HoldLink({
  href,
  newTab,
  label,
  holdLabel,
  doneLabel,
  ariaLabel,
  className,
  style,
  data,
  small = false,
  onDone,
}: {
  href: string;
  newTab: boolean;
  label: string;
  holdLabel: string;
  doneLabel: string;
  ariaLabel?: string;
  className: string;
  style?: CSSProperties;
  /** data-* attributes for the page's tests and styles */
  data?: Record<string, string>;
  /** the label is set at 12.5 px (`smallLabel()` decides) */
  small?: boolean;
  /** told when the link opens (the page's aria-live announcement) */
  onDone?: () => void;
}) {
  const [phase, setPhase] = useState<HoldPhase>("idle");
  // a new key per label change: the label rolls in (CSS)
  const [turn, setTurn] = useState(0);
  const state = useRef<HoldState>(IDLE);
  const timer = useRef<number | undefined>(undefined);
  const pressed = useRef(false);
  // A mouse hold whose gesture ran out before 1.2 s (a browser without a long activation): opens on the release.
  const pending = useRef(false);
  const ref = useRef<HTMLAnchorElement>(null);
  // the phase timer calls the newest dispatch (set below)
  const onTimer = useRef<() => void>(() => {});

  const open = useCallback(
    (how: HoldOpen) => {
      pending.current = false;
      if (how === "native") return;
      if (newTab && how === "tab") window.open(href, "_blank", "noopener");
      else window.location.assign(href);
    },
    [href, newTab],
  );

  const dispatch = useCallback(
    (event: HoldEvent) => {
      const step = holdStep(state.current, event);
      const before = state.current.phase;
      state.current = step.state;
      if (step.timer === null) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
      } else if (typeof step.timer === "number") {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onTimer.current(), step.timer);
      }
      if (step.state.phase !== before) {
        setPhase(step.state.phase);
        if (faceOf(step.state.phase) !== faceOf(before)) setTurn((n) => n + 1);
      }
      if (step.open) {
        onDone?.();
        const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
        if (step.open === "tab" && newTab && activation && !activation.isActive) pending.current = true;
        else open(step.open);
      }
    },
    [newTab, onDone, open],
  );

  useEffect(() => {
    onTimer.current = () => dispatch({ type: "timer" });
  }, [dispatch]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // The touch belongs to the link: no long-press menu, callout, selection or scroll from it (pointer events still come;
  // without a click a tap never follows the link — only the hold does).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", stop, { passive: false });
    return () => el.removeEventListener("touchstart", stop);
  }, []);

  // Back from the opened page (the back-forward cache keeps the page as it was): idle again.
  useEffect(() => {
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) {
        pending.current = false;
        dispatch({ type: "reset" });
      }
    };
    window.addEventListener("pageshow", back);
    return () => window.removeEventListener("pageshow", back);
  }, [dispatch]);

  const content = (face: Face, key: number) =>
    face === "done" ? (
      <>
        <span className="ppi-cb-badge" aria-hidden="true">
          <Suspense fallback={null}>
            <CheckLoop key={key} />
          </Suspense>
        </span>
        {doneLabel}
      </>
    ) : face === "hold" ? (
      holdLabel
    ) : (
      label
    );

  const input = (type: string): HoldInput => (type === "mouse" ? "mouse" : type === "pen" ? "pen" : "touch");

  return (
    <a
      ref={ref}
      href={href}
      {...(newTab ? { target: "_blank", rel: "noopener" } : {})}
      className={className}
      style={style}
      aria-label={ariaLabel ?? label}
      data-phase={phase}
      data-hold-link=""
      data-fit={small ? "small" : undefined}
      {...Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]))}
      draggable={false}
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0) return;
        pressed.current = true;
        void loadCheck();
        // without capture the pointer can slide off the link, which cancels
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // not captured
        }
        dispatch({ type: "press", input: input(e.pointerType) });
      }}
      onPointerUp={() => {
        if (state.current.phase === "holding") dispatch({ type: "release" });
        else if (pending.current) open("tab");
      }}
      onTouchEnd={() => {
        if (state.current.phase === "holding") dispatch({ type: "release" });
      }}
      onPointerLeave={() => dispatch({ type: "cancel" })}
      // A finger keeps its pointer on a link even when it slides away: off the link = cancel.
      onPointerMove={(e) => {
        if (state.current.phase === "holding" && !inside(e.currentTarget, e.clientX, e.clientY)) dispatch({ type: "cancel" });
      }}
      onTouchMove={(e) => {
        const t = e.touches[0];
        if (t && state.current.phase === "holding" && !inside(e.currentTarget, t.clientX, t.clientY)) dispatch({ type: "cancel" });
      }}
      onPointerCancel={() => dispatch({ type: "cancel" })}
      onBlur={() => dispatch({ type: "cancel" })}
      onFocus={() => void loadCheck()}
      onKeyDown={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        if (!e.repeat) dispatch({ type: "key" });
      }}
      onKeyUp={(e) => {
        if (e.key === " ") e.preventDefault();
      }}
      onClick={(e) => {
        // A click after a press is the browser's own: the hold decides, never the click.
        if (pressed.current) {
          pressed.current = false;
          e.preventDefault();
          if (pending.current) open("tab");
          return;
        }
        // A click without a press (a screen reader, a switch device): open it as the browser would.
        if (state.current.phase === "done") e.preventDefault();
        else dispatch({ type: "activate" });
      }}
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
    >
      <span className="ppi-cb-clip" aria-hidden="true">
        <span className="ppi-cb-fill" />
      </span>
      {phase === "done" && <span key={turn} className="ppi-cb-ring" aria-hidden="true" />}
      <span className="ppi-cb-label" aria-hidden="true">
        <span key={turn} className="ppi-cb-layer" data-entering={turn > 0 || undefined}>
          {content(faceOf(phase), turn)}
        </span>
      </span>
    </a>
  );
}
