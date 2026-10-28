"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { CheckLoop } from "@/components/CheckLoop";
import { DONE_MS, HOLD_MS, type ContactButtonData, type ContactKey } from "@/lib/contactButtons";

export interface ContactButtonLabels {
  hold: string;
  /** "{label}: {done}" for the screen-reader announcement. */
  announce: string;
  done: Record<ContactKey, string>;
}

type Phase = "idle" | "holding" | "done";
interface Layer {
  id: number;
  phase: Phase;
  leaving: boolean;
}

/**
 * The shop page's contact buttons (database update 51): two columns, a long button takes both. Each one acts only after
 * it was held for 1.2 s (pointer or Space/Enter): a quick tap does nothing, letting go early or sliding off cancels.
 * The order, links, colours and widths come from `@/lib/contactButtons`; the page also renders plain links in
 * `<noscript>`.
 */
export function ContactButtons({ buttons, labels }: { buttons: ContactButtonData[]; labels: ContactButtonLabels }) {
  const [said, setSaid] = useState<{ n: number; text: string }>({ n: 0, text: "" });
  const announce = useCallback((text: string) => setSaid((s) => ({ n: s.n + 1, text })), []);
  if (buttons.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3" data-contact-buttons>
      {buttons.map((b) => (
        <HoldButton key={b.key} button={b} labels={labels} onDone={announce} />
      ))}
      <span className="sr-only" aria-live="polite" data-contact-announce>
        {said.text && <span key={said.n}>{said.text}</span>}
      </span>
    </div>
  );
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

function HoldButton({ button, labels, onDone }: { button: ContactButtonData; labels: ContactButtonLabels; onDone: (text: string) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [layers, setLayers] = useState<Layer[]>([{ id: 0, phase: "idle", leaving: false }]);
  const phaseRef = useRef<Phase>("idle");
  const nextId = useRef(1);
  const holdTimer = useRef<number | undefined>(undefined);
  const doneTimer = useRef<number | undefined>(undefined);
  // Phones (and any browser without user activation left) allow opening a link only inside a gesture: a finger hold
  // opens it when the finger is lifted (touchend), never from the timer. Phones send no click after a long press.
  const pending = useRef(false);
  const byTouch = useRef(false);
  const ref = useRef<HTMLButtonElement>(null);
  const doneLabel = labels.done[button.key];

  const go = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
    const id = nextId.current++;
    // at most two labels: the one rolling away and the new one
    setLayers((all) => [...all.filter((l) => !l.leaving).map((l) => ({ ...l, leaving: true })), { id, phase: next, leaving: false }]);
  }, []);

  const act = useCallback(() => {
    pending.current = false;
    if (button.newTab) window.open(button.href, "_blank", "noopener");
    else window.location.href = button.href;
  }, [button.href, button.newTab]);

  const complete = useCallback(() => {
    holdTimer.current = undefined;
    go("done");
    onDone(fill(labels.announce, { label: button.label, done: doneLabel }));
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (byTouch.current || (activation && !activation.isActive)) pending.current = true;
    else act();
    doneTimer.current = window.setTimeout(() => go("idle"), DONE_MS);
  }, [act, button.label, doneLabel, go, labels.announce, onDone]);

  const start = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    pending.current = false;
    go("holding");
    holdTimer.current = window.setTimeout(complete, HOLD_MS);
  }, [complete, go]);

  const cancel = useCallback(() => {
    if (phaseRef.current !== "holding") return;
    window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    go("idle");
  }, [go]);

  useEffect(
    () => () => {
      window.clearTimeout(holdTimer.current);
      window.clearTimeout(doneTimer.current);
    },
    [],
  );

  // No long-press gesture of the phone's own (context menu, callout, selection, a cancelled pointer): the touch belongs
  // to the button. Pointer events still arrive; touchend still counts as a gesture for opening the link.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", stop, { passive: false });
    return () => el.removeEventListener("touchstart", stop);
  }, []);

  // A label that does not fit at 15 px is set at 12.5 px (never cut, never wrapped); checked again when the width or
  // the font changes. Written on the element, not in state: it never re-renders the button.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const room = el.clientWidth - 24;
      const need = Math.max(...Array.from(el.querySelectorAll<HTMLElement>("[data-measure]"), (m) => m.scrollWidth));
      if (need > room) el.dataset.fit = "small";
      else delete el.dataset.fit;
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    void document.fonts?.ready.then(check);
    return () => observer.disconnect();
  }, [button.label, doneLabel, labels.hold]);

  const content = (p: Phase, key: number) =>
    p === "done" ? (
      <>
        <span className="ppi-cb-badge" aria-hidden="true">
          <CheckLoop key={key} />
        </span>
        {doneLabel}
      </>
    ) : p === "holding" ? (
      labels.hold
    ) : (
      button.label
    );

  return (
    <button
      ref={ref}
      type="button"
      className={`ppi-cb ${button.width === "long" ? "col-span-2" : ""}`}
      style={{ "--c": button.color } as CSSProperties}
      aria-label={button.label}
      data-contact={button.key}
      data-width={button.width}
      data-phase={phase}
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0) return;
        byTouch.current = e.pointerType !== "mouse";
        // without capture the pointer can slide off the button, which cancels
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // not captured
        }
        start();
      }}
      onPointerUp={(e) => {
        if (phaseRef.current === "holding") cancel();
        // a mouse or pen release opens a link that was waiting; a finger waits for its touchend (iPhone Safari's gesture)
        else if (pending.current && e.pointerType !== "touch") act();
      }}
      onTouchEnd={() => {
        if (phaseRef.current === "holding") cancel();
        else if (pending.current) act();
      }}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onBlur={cancel}
      onKeyDown={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        if (!e.repeat) {
          byTouch.current = false;
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        if (phaseRef.current === "holding") cancel();
        else if (pending.current) act();
      }}
      onClick={(e) => {
        e.preventDefault();
        if (pending.current) act();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="ppi-cb-clip" aria-hidden="true">
        <span className="ppi-cb-fill" />
        {/* the three texts at 15 px, invisible (and clipped): what decides whether the button needs the smaller size */}
        <span className="ppi-cb-measure" data-measure>
          {button.label}
        </span>
        <span className="ppi-cb-measure" data-measure>
          {labels.hold}
        </span>
        <span className="ppi-cb-measure" data-measure>
          <span className="ppi-cb-badge" />
          {doneLabel}
        </span>
      </span>
      {phase === "done" && <span key={layers[layers.length - 1].id} className="ppi-cb-ring" aria-hidden="true" />}
      <span className="ppi-cb-label" aria-hidden="true">
        {layers.map((l) => (
          <span
            key={l.id}
            className="ppi-cb-layer"
            data-leaving={l.leaving || undefined}
            data-entering={(!l.leaving && l.id > 0) || undefined}
            onAnimationEnd={(e) => {
              if (l.leaving && e.target === e.currentTarget) setLayers((all) => all.filter((x) => x.id !== l.id));
            }}
          >
            {content(l.phase, l.id)}
          </span>
        ))}
      </span>
    </button>
  );
}
