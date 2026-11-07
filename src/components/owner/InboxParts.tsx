"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * CRM → Konverzácie's client parts (2026-11-07; artboards 8 / 8b). The server draws every row, message and form; these
 * only size and scroll: InboxFrame (≥ 1024 px the inbox fills the height under the tabs, `calc(100dvh − its top)`,
 * min 560 px, so the page itself does not scroll), InboxList (keeps its scroll place per shop, "Vybrať" → round select
 * circles and the toolbar), MessagesScroll (the newest message in view on opening), DialogButton (a menu item that
 * opens a dialog with a server form in it).
 */

/** The two-pane frame: its top is measured, so the height is the rest of the window. */
export function InboxFrame({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.setProperty("--inbox-top", `${Math.round(top)}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return (
    <div ref={ref} className="ppi-inbox" data-inbox {...(open ? { "data-open": "" } : {})}>
      {children}
    </div>
  );
}

const SCROLL_KEY = (shop: string) => `ppi.crm.listScroll.${shop}`;

/**
 * The list pane: it keeps its scroll place between conversations (≥ 1024 px, sessionStorage, try/catch) and brings the
 * open row into view. "Vybrať" shows a round circle on every row (a real checkbox of the bulk form); the toolbar: Vybrať
 * všetko · Stiahnuť (each conversation its own PDF) · Archivovať · Vymazať (asks first) · Hotovo; Esc leaves.
 */
export function InboxList({
  shop,
  formId,
  labels,
  head,
  children,
}: {
  shop: string;
  formId: string;
  labels: { select: string; select_all: string; download: string; archive: string; delete: string; done: string; delete_confirm: string; downloading: string; download_failed: string };
  head: ReactNode;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    try {
      const saved = Number(sessionStorage.getItem(SCROLL_KEY(shop)) ?? "");
      if (Number.isFinite(saved) && saved > 0) el.scrollTop = saved;
    } catch {
      // no storage: the list starts at the top
    }
    const open = el.querySelector<HTMLElement>('[aria-current="true"]');
    if (open) {
      const r = open.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom) open.scrollIntoView({ block: "nearest" });
    }
    const keep = () => {
      try {
        sessionStorage.setItem(SCROLL_KEY(shop), String(el.scrollTop));
      } catch {
        // ignored
      }
    };
    el.addEventListener("scroll", keep, { passive: true });
    return () => el.removeEventListener("scroll", keep);
  }, [shop]);

  useEffect(() => {
    if (!selecting) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelecting(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [selecting]);

  const ticks = () => [...document.querySelectorAll<HTMLInputElement>(`input[form="${formId}"][name="ids"]`)];
  const submit = (op: string) => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form || !ticks().some((t) => t.checked)) return;
    if (op === "delete" && !window.confirm(labels.delete_confirm)) return;
    (form.querySelector('input[name="op"]') as HTMLInputElement).value = op;
    (form.querySelector('input[name="confirm"]') as HTMLInputElement).value = op === "delete" ? "on" : "";
    form.requestSubmit();
  };
  const download = async () => {
    const ids = ticks().filter((t) => t.checked).map((t) => t.value);
    if (!ids.length) return;
    setNote(labels.downloading.replace("{n}", String(ids.length)));
    try {
      const res = await fetch("/api/owner/conversations/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      const answer = (res.ok ? await res.json() : null) as { files?: { url: string; name: string }[] } | null;
      if (!answer) throw new Error(String(res.status));
      for (const [i, file] of (answer.files ?? []).entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 700));
        const link = document.createElement("a");
        link.href = file.url;
        link.rel = "noopener";
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setNote(null);
    } catch {
      setNote(labels.download_failed);
    }
  };
  const tool = "min-h-11 rounded-lg px-2 text-[14px] font-bold text-[#111] hover:bg-[#F2F2F2]";

  return (
    <section className="ppi-inbox-list" aria-labelledby="inbox-list-title" data-inbox-list {...(selecting ? { "data-selecting": "" } : {})}>
      <div className="flex flex-none flex-col gap-2 px-2.5 pb-1.5 pt-3">
        {head}
        {selecting ? (
          <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={labels.select} data-inbox-toolbar>
            <button type="button" className={tool} onClick={() => ticks().forEach((t) => (t.checked = true))} data-inbox-select-all>
              {labels.select_all}
            </button>
            <button type="button" className={tool} onClick={() => void download()} data-inbox-download>
              {labels.download}
            </button>
            <button type="button" className={tool} onClick={() => submit("archive")} data-inbox-archive>
              {labels.archive}
            </button>
            <button type="button" className={tool} onClick={() => submit("delete")} data-inbox-delete>
              {labels.delete}
            </button>
            <button
              type="button"
              className={`${tool} ml-auto`}
              onClick={() => {
                ticks().forEach((t) => (t.checked = false));
                setSelecting(false);
              }}
              data-inbox-select-done
            >
              {labels.done}
            </button>
          </div>
        ) : (
          <button type="button" className="self-end text-[14px] font-bold underline underline-offset-4" onClick={() => setSelecting(true)} data-inbox-select>
            {labels.select}
          </button>
        )}
        {note && (
          <p className="text-[13px] text-[#5C5C5C]" aria-live="polite">
            {note}
          </p>
        )}
      </div>
      <div ref={box} className="ppi-inbox-rows" data-inbox-rows>
        {children}
      </div>
    </section>
  );
}

/** The conversation's messages: they scroll inside; the newest is in view when it opens (and after a reply). */
export function MessagesScroll({ id, count, children }: { id: string; count: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [id, count]);
  return (
    <div ref={ref} className="ppi-inbox-messages" data-inbox-messages>
      {children}
    </div>
  );
}

/** A "⋯" menu item that opens a dialog (Poznámka, Prepojiť s kontaktom, Vymazať): Esc or "Zavrieť" closes it. */
export function DialogButton({ label, title, close, attr, children }: { label: string; title: string; close: string; attr: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-[15px] font-semibold hover:bg-[#F2F2F2]" onClick={() => ref.current?.showModal()} {...{ [attr]: "" }}>
        {label}
      </button>
      <dialog ref={ref} className="m-auto w-[min(92vw,480px)] rounded-2xl border border-[#E4E4E4] p-0 backdrop:bg-black/40" aria-label={title}>
        <div className="flex flex-col gap-3 p-5">
          <h2 className="text-lg font-bold">{title}</h2>
          {children}
          <button type="button" className="min-h-11 self-end rounded-xl border border-[#D6D6D6] px-4 font-bold" onClick={() => ref.current?.close()}>
            {close}
          </button>
        </div>
      </dialog>
    </>
  );
}
