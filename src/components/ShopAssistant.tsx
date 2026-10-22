"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { ShopChat as Chat } from "./ShopChat";

type Props = Omit<ComponentProps<typeof Chat>, "initialText" | "focusInput" | "keysOpen">;

/**
 * The shop assistant's first view, light (performance pass): the same box, texts and field as `ShopChat`, so the page
 * looks the same at once and nothing moves; the assistant's own code (chat, files, PDFs, access keys) is not part of
 * the page's first JavaScript. It loads when the box comes near the screen (after the page has loaded, when the
 * browser is idle) or at the first touch, focus or key; what was typed meanwhile goes along and the cursor stays.
 */
export function ShopAssistant(props: Props) {
  const { lang, shopName, keys, labels, buttonLabel, welcome, archive = false } = props;
  const [live, setLive] = useState<{ Chat: typeof Chat } | null>(null);
  // What the shopper did in the first view goes along at the swap: the text, the cursor, an opened key dropdown.
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const box = useRef<HTMLElement>(null);
  const loading = useRef(false);

  // The first view stays until the assistant's code is here (nothing disappears or moves).
  const load = () => {
    if (loading.current) return;
    loading.current = true;
    import("./ShopChat")
      .then((m) => setLive({ Chat: m.ShopChat }))
      .catch(() => {
        loading.current = false;
      });
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let idle = 0;
    let timer = 0;
    const soon = () => {
      const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
      if (w.requestIdleCallback) idle = w.requestIdleCallback(() => load(), { timeout: 3000 });
      else timer = window.setTimeout(() => load(), 1200);
    };
    const observer = new IntersectionObserver(
      (seen) => {
        if (!seen.some((e) => e.isIntersecting)) return;
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
      if (idle) (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  if (live) return <live.Chat {...props} initialText={text} focusInput={focused} keysOpen={keysOpen} />;

  const title = buttonLabel?.trim() || labels.title;
  const intro = welcome?.trim() || labels.intro;
  return (
    <div className="contents" onPointerDown={() => load()}>
      <section ref={box} className="flex flex-col border border-line" aria-labelledby="assistant-heading" data-assistant>
        <h2 id="assistant-heading" className="p-3 font-semibold">
          {title}
        </h2>
        <div className="flex flex-col gap-3 border-t border-line p-3">
          <p className="text-sm text-muted" data-chat-welcome>
            {intro}
          </p>
          {archive && (
            <p className="text-xs text-muted" data-chat-privacy>
              {labels.privacy_notice.replace("{shop}", shopName)}{" "}
              <Link href={`/${lang}/sukromie-asistent`} className="underline underline-offset-4">
                {labels.privacy_more}
              </Link>
            </p>
          )}
          <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto overscroll-contain md:max-h-[65vh]" data-chat-log />
          <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => {
                setFocused(true);
                load();
              }}
              onBlur={() => setFocused(false)}
              rows={2}
              maxLength={1500}
              placeholder={labels.placeholder}
              aria-label={labels.placeholder}
              className="rounded border border-line px-3 py-2 outline-none focus:border-foreground"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onFocus={() => load()} className="rounded border border-line px-3 py-2">
                {labels.photo}
              </button>
              <button type="submit" disabled className="rounded border border-foreground px-4 py-2 font-medium disabled:text-muted">
                {labels.send}
              </button>
            </div>
            <p className="text-xs text-muted">
              {archive ? labels.files_note : labels.photo_note} {labels.note}
            </p>
          </form>
        </div>
      </section>
      {keys && (
        <details
          className="border border-line"
          data-key-access
          onToggle={(e) => {
            setKeysOpen(e.currentTarget.open);
            load();
          }}
        >
          <summary className="cursor-pointer p-3 font-semibold">{labels.key_have}</summary>
        </details>
      )}
    </div>
  );
}
