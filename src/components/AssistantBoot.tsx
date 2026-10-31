"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { ShopChat as Chat } from "./ShopChat";

export type AssistantProps = Omit<ComponentProps<typeof Chat>, "initialText" | "focusInput" | "keysOpen" | "sendNow">;

/**
 * The assistant's loader (performance pass, Screen 11): the first view is plain HTML written on the server
 * (`ShopAssistant`), this small part only listens to it — and loads the assistant's own code (`ShopChat`) when the box
 * comes near the screen (after the page has loaded, when the browser is idle) or at the first touch, focus or key.
 * What the shopper did meanwhile goes along: the typed text, the cursor, an opened key row, a tapped "Poslať" (an empty
 * question says "Napíšte otázku alebo pridajte fotku" here already).
 */
export function AssistantBoot({ props, children }: { props: AssistantProps; children: ReactNode }) {
  type Seen = { text: string; focused: boolean; keysOpen: boolean; sendNow: boolean };
  const [live, setLive] = useState<{ Chat: typeof Chat; seen: Seen } | null>(null);
  const seen = useRef<Seen>({ text: "", focused: false, keysOpen: false, sendNow: false });
  const box = useRef<HTMLDivElement>(null);
  const loading = useRef(false);

  const load = () => {
    if (loading.current) return;
    loading.current = true;
    import("./ShopChat")
      // what the shopper did up to the swap goes along
      // (the field's own value: typing may have started before this part was ready)
      .then((m) => setLive({ Chat: m.ShopChat, seen: { ...seen.current, text: box.current?.querySelector("textarea")?.value ?? seen.current.text } }))
      .catch(() => {
        loading.current = false;
      });
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let idle = 0;
    let timer = 0;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const soon = () => {
      if (w.requestIdleCallback) idle = w.requestIdleCallback(() => load(), { timeout: 3000 });
      else timer = window.setTimeout(() => load(), 1200);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        if (document.readyState === "complete") soon();
        else window.addEventListener("load", soon, { once: true });
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.removeEventListener("load", soon);
      if (idle) w.cancelIdleCallback?.(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  if (live) {
    const s = live.seen;
    return <live.Chat {...props} initialText={s.text} focusInput={s.focused && !s.sendNow} keysOpen={s.keysOpen} sendNow={s.sendNow} />;
  }

  const empty = (on: boolean) => {
    const el = box.current;
    el?.querySelector("[data-chat-empty]")?.toggleAttribute("hidden", !on);
    el?.querySelector("textarea")?.toggleAttribute("aria-invalid", on);
  };
  return (
    <div
      ref={box}
      className="flex flex-col gap-[18px]"
      onPointerDown={load}
      onFocus={(e) => {
        load();
        if (e.target instanceof HTMLTextAreaElement) seen.current.focused = true;
      }}
      onBlur={(e) => {
        if (e.target instanceof HTMLTextAreaElement) seen.current.focused = false;
      }}
      onInput={(e) => {
        if (!(e.target instanceof HTMLTextAreaElement)) return;
        seen.current.text = e.target.value;
        empty(false);
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!(box.current?.querySelector("textarea")?.value ?? "").trim()) return empty(true);
        seen.current.sendNow = true;
        (e.target as HTMLFormElement).querySelector("[data-chat-send]")?.setAttribute("disabled", "");
        load();
      }}
      onClick={(e) => {
        const toggle = (e.target as HTMLElement).closest("[data-key-toggle]");
        if (!toggle) return;
        const open = !seen.current.keysOpen;
        seen.current.keysOpen = open;
        toggle.setAttribute("aria-expanded", String(open));
        toggle.closest("[data-key-access]")?.toggleAttribute("data-open", open);
        load();
      }}
    >
      {children}
    </div>
  );
}
