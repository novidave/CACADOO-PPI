"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createContactInline, type PickedContact } from "@/app/[lang]/(account)/dashboard/contacts/messageActions";
import { MessageComposer, type ComposerTemplate } from "@/components/MessageComposer";
import { NAV_ICONS } from "./navIcons";
import { buttonClass, fieldClass, ghostClass } from "./ui";

const fill = (text: string, values: Record<string, string | number>) =>
  String(text ?? "").replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

function PlusIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d={NAV_ICONS.plus} />
    </svg>
  );
}

/**
 * CRM → Správy (2026-11-04): "Komu" — a live search of the shop's contacts (name, phone, e-mail; 200 ms after the last
 * key, only the newest answer counts; ↑ ↓ Enter), or "+ Nový kontakt" (a dialog with the contact's fields; after saving
 * the new contact is the recipient) — then the same composer as a contact's Správy (channels the contact has, a
 * template, the tags, "Opraviť gramatiku", "Náhľad", "Odoslať" through crm-messages with its quotas and log).
 */
export function MessageCenter({
  lang,
  shopId,
  shopSlug,
  texts,
  composerTexts,
  newContactFields,
  templates,
  emailReady,
  smsLive,
  grammarOn,
  canWrite,
  initial,
}: {
  lang: string;
  shopId: string;
  shopSlug: string;
  /** crm_msg.* */
  texts: Record<string, string>;
  /** contacts.* (the composer's and the contact form's words) */
  composerTexts: Record<string, string>;
  /** the server-drawn fields of a new contact (ContactFields) */
  newContactFields: ReactNode;
  templates: ComposerTemplate[];
  emailReady: boolean;
  smsLive: boolean;
  grammarOn: boolean;
  /** the shop has the plan (writing and sending) */
  canWrite: boolean;
  initial: PickedContact | null;
}) {
  const [picked, setPicked] = useState<PickedContact | null>(initial);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PickedContact[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [active, setActive] = useState(-1);
  const [newError, setNewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const listId = useId();

  // the live search: 200 ms after the last key, only the newest answer is shown
  useEffect(() => {
    const words = q.trim();
    if (!words) return;
    const mine = ++seq.current;
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setState("searching");
      try {
        const res = await fetch(`/api/owner/contacts/search?${new URLSearchParams({ shop_id: shopId, q: words })}`, { signal: ctrl.signal, cache: "no-store" });
        const out = (await res.json()) as { rows?: PickedContact[] };
        if (mine !== seq.current) return;
        if (!res.ok) throw new Error("search");
        setRows(out.rows ?? []);
        setActive(-1);
        setState("done");
      } catch {
        if (mine === seq.current && !ctrl.signal.aborted) setState("error");
      }
    }, 200);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, shopId]);

  const choose = (c: PickedContact) => {
    setPicked(c);
    setQ("");
    setRows([]);
    setState("idle");
    const url = new URL(window.location.href);
    url.searchParams.set("to", c.id);
    window.history.replaceState(null, "", url);
  };
  const open = q.trim() !== "" && (state === "done" || state === "searching" || state === "error");

  return (
    <section className="flex flex-col gap-4" aria-label={texts.to} data-message-center>
      {picked ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E4E4E4] p-3" data-recipient={picked.id}>
          <div className="flex min-w-0 flex-col">
            <span className="text-xs font-semibold text-[#5C5C5C]">{texts.to}</span>
            <strong className="truncate text-[17px]">{picked.name || picked.phone || picked.email}</strong>
            <span className="truncate text-sm text-[#5C5C5C]">{[picked.phone, picked.email].filter(Boolean).join(" · ")}</span>
          </div>
          <button
            type="button"
            className={ghostClass}
            onClick={() => {
              setPicked(null);
              window.setTimeout(() => input.current?.focus(), 0);
            }}
            data-recipient-change
          >
            {texts.change}
          </button>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <div className="relative min-w-0 flex-1">
            <label className="sr-only" htmlFor={`${listId}-q`}>
              {texts.to}
            </label>
            <input
              ref={input}
              id={`${listId}-q`}
              type="search"
              role="combobox"
              aria-expanded={open}
              aria-controls={`${listId}-list`}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? `${listId}-o${active}` : undefined}
              autoComplete="off"
              placeholder={`${texts.to}: ${texts.search_ph}`}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                if (!e.target.value.trim()) {
                  seq.current++;
                  setRows([]);
                  setState("idle");
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(rows.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter" && active >= 0 && rows[active]) {
                  e.preventDefault();
                  choose(rows[active]);
                } else if (e.key === "Escape") {
                  setQ("");
                  setRows([]);
                  setState("idle");
                }
              }}
              className={fieldClass}
              data-recipient-search
            />
            {open && (
              <ul
                id={`${listId}-list`}
                role="listbox"
                aria-label={texts.results}
                className="absolute left-0 right-0 top-full z-30 mt-1 flex max-h-80 flex-col overflow-y-auto rounded-xl border border-[#E4E4E4] bg-white p-1 shadow-[0_8px_24px_rgba(17,17,17,.12)]"
                data-recipient-results
              >
                {state === "searching" && rows.length === 0 && <li className="px-3 py-2 text-sm text-[#5C5C5C]">{texts.searching}</li>}
                {state === "error" && <li className="px-3 py-2 text-sm">{texts.err_search}</li>}
                {state === "done" && rows.length === 0 && <li className="px-3 py-2 text-sm text-[#5C5C5C]" data-recipient-none>{texts.none}</li>}
                {rows.map((r, i) => (
                  <li
                    key={r.id}
                    id={`${listId}-o${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(r)}
                    className={`flex min-h-11 cursor-pointer flex-col justify-center rounded-lg px-3 py-1.5 ${i === active ? "bg-[#F4F4F4]" : "hover:bg-[#F4F4F4]"}`}
                    data-recipient-option={r.id}
                  >
                    <span className="font-semibold">{r.name || r.phone || r.email}</span>
                    <span className="text-sm text-[#5C5C5C]">{[r.phone, r.email].filter(Boolean).join(" · ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {canWrite && (
            <button
              ref={opener}
              type="button"
              onClick={() => {
                setNewError(null);
                dialog.current?.showModal();
              }}
              aria-haspopup="dialog"
              className={`${buttonClass} h-[52px] flex-none px-4`}
              data-new-contact-open
            >
              <PlusIcon />
              <span className="hidden sm:inline">{texts.new_contact}</span>
              <span className="sr-only sm:hidden">{texts.new_contact}</span>
            </button>
          )}
        </div>
      )}

      <dialog
        ref={dialog}
        aria-labelledby={`${listId}-new`}
        onClose={() => opener.current?.focus()}
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
        className="m-auto w-[min(560px,calc(100vw-32px))] max-w-none rounded-2xl border border-[#E4E4E4] bg-white p-0 text-[#111] backdrop:bg-[#111]/40"
        data-new-contact-dialog
      >
        <form
          className="flex max-h-[85dvh] flex-col gap-3 overflow-y-auto p-5"
          action={async (fd) => {
            setSaving(true);
            setNewError(null);
            const out = await createContactInline(fd);
            setSaving(false);
            if (!out.ok) {
              setNewError(composerTexts[out.error] ?? composerTexts.err_failed);
              return;
            }
            dialog.current?.close();
            choose(out.contact);
          }}
        >
          <h2 id={`${listId}-new`} className="text-xl font-bold">
            {texts.new_contact}
          </h2>
          <input type="hidden" name="shop_id" value={shopId} />
          <input type="hidden" name="shop_slug" value={shopSlug} />
          <input type="hidden" name="lang" value={lang} />
          {newError && (
            <p role="alert" className="text-sm font-semibold" data-new-contact-error>
              {newError}
            </p>
          )}
          {newContactFields}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={saving} className={buttonClass} data-new-contact-save>
              {texts.new_save}
            </button>
            <button type="button" onClick={() => dialog.current?.close()} className={ghostClass}>
              {texts.new_cancel}
            </button>
          </div>
        </form>
      </dialog>

      {!picked ? (
        <p className="text-sm text-[#5C5C5C]" data-pick-first>
          {texts.pick_first}
        </p>
      ) : !picked.phone && !picked.email ? (
        <p className="text-sm font-semibold">{texts.no_channel}</p>
      ) : canWrite ? (
        <MessageComposer
          key={picked.id}
          lang={lang}
          contactId={picked.id}
          hasPhone={Boolean(picked.phone)}
          hasEmail={Boolean(picked.email)}
          emailReady={emailReady}
          smsLive={smsLive}
          templates={templates}
          texts={composerTexts}
          shopId={shopId}
          grammarOn={grammarOn}
        />
      ) : (
        <p className="text-sm">{composerTexts.needs_plan}</p>
      )}
      <span className="sr-only" aria-live="polite">
        {picked ? fill(`${texts.selected}: {name}`, { name: picked.name ?? "" }) : ""}
      </span>
    </section>
  );
}
