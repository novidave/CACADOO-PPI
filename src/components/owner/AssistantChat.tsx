"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { chatStore, type ChatMessage } from "@/lib/assistantStore";
import { NAV_ICONS } from "./navIcons";

export type ChatTexts = Record<string, string>;

const fill = (text: string, values: Record<string, string | number>) =>
  String(text ?? "").replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

function Icon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
      <path d={d} />
    </svg>
  );
}

/** A Cacaduu screen of a help topic with the language and the open shop. */
const screenHref = (lang: string, link: string, shop: string) => `/${lang}${link}${link.includes("?") ? "&" : "?"}${new URLSearchParams({ shop })}`;

/**
 * The AI pomocník's conversation (the computer's side panel and the phone's page share it, @/lib/assistantStore): the
 * owner's questions and the answers, a card per proposed change (before → after, "Potvrdiť" / "Zrušiť" — nothing
 * changes before it), links to the Cacaduu screens the answer used, "Zastaviť" while it answers, "Nová konverzácia".
 * Enter sends, Shift+Enter makes a new line. Every part is the owner shell's look (black, white, grey; 44–52 px).
 */
export function AssistantChat({
  lang,
  shop,
  texts,
  variant,
  onClose,
}: {
  lang: string;
  shop: string;
  texts: ChatTexts;
  variant: "panel" | "page";
  onClose?: () => void;
}) {
  const chat = useSyncExternalStore(chatStore.subscribe, chatStore.get, chatStore.initial);
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chatStore.setShop(shop);
  }, [shop]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chat.messages.length, chat.busy]);

  const send = () => {
    const q = draft.trim();
    if (!q || chat.busy) return;
    setDraft("");
    void chatStore.send(q, lang);
  };
  const noteOf = (m: ChatMessage) => (m.notice === "stopped" ? texts.stopped : m.notice ? (texts[m.notice] ?? texts.err_failed) : null);

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${variant === "page" ? "" : "h-full"}`} data-assistant-chat={variant}>
      <div className="flex flex-none items-center justify-between gap-2 border-b border-[#E4E4E4] px-4 py-2">
        {variant === "panel" ? (
          <h2 className="truncate text-lg font-bold" id="ai-panel-title">
            {texts.title}
          </h2>
        ) : (
          <span className="sr-only">{texts.title}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => chatStore.clear()}
            disabled={chat.messages.length === 0 && !chat.busy}
            className="min-h-11 rounded-xl px-3 text-sm font-semibold text-[#111] hover:bg-[#F4F4F4] disabled:text-[#9A9A9A]"
            data-ai-new
          >
            {texts.new_chat}
          </button>
          {onClose && (
            <button type="button" onClick={onClose} aria-label={texts.close} title={texts.close} className="flex size-11 items-center justify-center rounded-xl hover:bg-[#F4F4F4]" data-ai-close>
              <Icon d={NAV_ICONS.close} />
            </button>
          )}
        </div>
      </div>

      <div ref={list} role="log" aria-live="polite" aria-label={texts.messages} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" data-ai-messages>
        {chat.messages.length === 0 && <p className="text-sm text-[#5C5C5C]">{texts.intro}</p>}
        {chat.messages.map((m) =>
          m.role === "u" ? (
            <div key={m.id} className="ml-8 self-end whitespace-pre-line break-words rounded-2xl rounded-br-md bg-[#111] px-3.5 py-2.5 text-[15px] text-white" data-ai-msg="u">
              <span className="sr-only">{texts.you}: </span>
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="mr-6 flex flex-col gap-2 self-start" data-ai-msg="a">
              {(m.text || noteOf(m)) && (
                <div className="whitespace-pre-line break-words rounded-2xl rounded-bl-md bg-[#F4F4F4] px-3.5 py-2.5 text-[15px] text-[#111]">
                  <span className="sr-only">{texts.helper}: </span>
                  {m.text || <span className="font-semibold">{noteOf(m)}</span>}
                </div>
              )}
              {m.text && noteOf(m) && <p className="text-sm font-semibold">{noteOf(m)}</p>}
              {(m.proposals ?? []).map((p) => (
                <section key={p.id} className="flex flex-col gap-2 rounded-2xl border border-[#111] bg-white p-3" aria-label={texts.confirm_title} data-ai-proposal={p.state}>
                  <strong className="text-sm">{texts.confirm_title}</strong>
                  <ul className="flex flex-col gap-0.5 text-sm">
                    {p.lines.filter((l) => l !== "").map((l, i) => (
                      <li key={i} className="break-words">
                        {l}
                      </li>
                    ))}
                  </ul>
                  {p.state === "done" ? (
                    <p role="status" className="text-sm font-semibold">✓ {texts.confirmed}</p>
                  ) : p.state === "cancelled" ? (
                    <p role="status" className="text-sm text-[#5C5C5C]">{texts.cancelled}</p>
                  ) : (
                    <>
                      {p.state === "error" && (
                        <p role="alert" className="text-sm font-semibold">
                          {p.note?.startsWith("change:")
                            ? fill(texts.err_change, { reason: p.note.slice(7) })
                            : p.note === "expired"
                              ? texts.err_expired
                              : p.note === "used"
                                ? texts.err_used
                                : texts.err_failed}
                        </p>
                      )}
                      <span className="text-xs text-[#5C5C5C]">{texts.confirm_expires}</span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={p.state === "busy"}
                          onClick={() => void chatStore.decide(m.id, p.id, "confirm", lang)}
                          className="min-h-11 flex-1 rounded-xl border border-[#111] bg-[#111] px-4 font-bold text-white disabled:opacity-60"
                          data-ai-confirm
                        >
                          {texts.confirm}
                        </button>
                        <button
                          type="button"
                          disabled={p.state === "busy"}
                          onClick={() => void chatStore.decide(m.id, p.id, "cancel", lang)}
                          className="min-h-11 rounded-xl border border-[#D6D6D6] bg-white px-4 font-bold text-[#111]"
                          data-ai-cancel
                        >
                          {texts.cancel}
                        </button>
                      </div>
                    </>
                  )}
                </section>
              ))}
              {m.sklad && (
                <Link href={screenHref(lang, "/dashboard/sklad", shop)} className="self-start text-sm font-semibold underline underline-offset-4">
                  {texts.open_sklad}
                </Link>
              )}
              {(m.links ?? []).map((l) => (
                <Link key={l.link} href={screenHref(lang, l.link, shop)} className="flex min-h-11 items-center self-start rounded-xl border border-[#E4E4E4] px-3 text-sm font-semibold hover:bg-[#F4F4F4]" data-ai-link>
                  {fill(texts.open_screen, { title: l.title })} →
                </Link>
              ))}
            </div>
          ),
        )}
        {chat.busy && (
          <p className="flex items-center gap-2 text-sm text-[#5C5C5C]" data-ai-thinking>
            {texts.thinking}
          </p>
        )}
      </div>

      <form
        className="flex flex-none items-end gap-2 border-t border-[#E4E4E4] bg-white px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label className="sr-only" htmlFor={`ai-box-${variant}`}>
          {texts.placeholder}
        </label>
        <textarea
          ref={box}
          id={`ai-box-${variant}`}
          rows={1}
          value={draft}
          maxLength={2000}
          placeholder={texts.placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className="max-h-40 min-h-[48px] flex-1 resize-none rounded-xl border border-[#D6D6D6] bg-white px-3.5 py-3 text-base text-[#111] outline-none [field-sizing:content] placeholder:text-[#8A8A8A] focus:border-[#111]"
          data-ai-input
        />
        {chat.busy ? (
          <button type="button" onClick={() => chatStore.stop()} className="flex h-12 flex-none items-center gap-1.5 rounded-xl border border-[#111] px-3 font-bold" data-ai-stop>
            <Icon d={NAV_ICONS.stop} size={18} />
            {texts.stop}
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()} className="flex h-12 flex-none items-center gap-1.5 rounded-xl border border-[#111] bg-[#111] px-3 font-bold text-white disabled:border-[#EDEDED] disabled:bg-[#EDEDED] disabled:text-[#5C5C5C]" data-ai-send>
            <Icon d={NAV_ICONS.send} size={18} />
            {texts.send}
          </button>
        )}
      </form>
      {chat.left !== null && <span className="sr-only">{fill(texts.left, { n: chat.left })}</span>}
    </div>
  );
}
