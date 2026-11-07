"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import {
  arrangeSlides,
  canAdd,
  CROPS,
  DEFAULT_RATIO,
  MAX_SLIDES,
  ratioSize,
  SLIDER_RATIOS,
  shownSlots,
  slotCounts,
  SLOT_KINDS,
  type ContentLimits,
  type Crop,
  type LibraryItem,
  type Slot,
  type SlotKind,
  type SlideImage,
  type SliderRatio,
  type SlideView,
} from "@/lib/pageContent";
import { videoSlide, type PostVideo, type VideoTarget } from "@/lib/video";
import { saveContent } from "@/app/[lang]/(account)/dashboard/sectionActions";
import { ContentSlider } from "./ContentSlider";
import { buttonClass, cardClass, fieldClass, ghostClass } from "@/components/owner/ui";

type Text = Dictionary["content"];

/** A library file as the editor shows it (the first page's picture: a 10-minute address). */
export interface EditorItem extends LibraryItem {
  title: string;
  showTitle: boolean;
  alt: string | null;
  pages: number;
  layout: "slider" | "stacked";
  image: SlideImage | null;
}

/** A visible post that can fill a slot (newest first). */
export interface EditorPost {
  id: string;
  title: string;
  date: string;
  dateTime: string;
  excerpt: string;
  href: string;
  image: SlideImage | null;
  video: PostVideo | null;
}

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

let nextKey = 0;
type Row = Slot & { key: number };
const withKey = (slot: Slot): Row => ({ ...slot, key: ++nextKey });

/** The shop page's content column (max-w-3xl) and a phone's screen: what the two previews are drawn at. */
const DESKTOP_WIDTH = 768;
const PHONE_WIDTH = 390;

/**
 * One preview drawn at the real width (a phone's 390 px screen with its 16 px margins, or the shop page's 768 px
 * column) and made smaller with a CSS transform when the editor's column is narrower: the box takes the scaled height,
 * so nothing is cut off and nothing scrolls sideways.
 */
function ScaledPreview({ width, padding, children }: { width: number; padding: number; children: React.ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ scale: number; height: number | null }>({ scale: 1, height: null });
  useEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const scale = Math.min(1, o.clientWidth / width);
      setSize({ scale, height: Math.ceil(i.offsetHeight * scale) });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    ro.observe(i);
    measure();
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={outer} className="w-full overflow-hidden" style={{ height: size.height ?? undefined, maxWidth: width }} data-preview-box>
      <div
        ref={inner}
        className="origin-top-left"
        style={{ width, padding, transform: size.scale < 1 ? `scale(${size.scale})` : undefined }}
        data-preview-scale={size.scale.toFixed(3)}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Môj obchod → "Obsah stránky" (database update 38): the slider's title and look, the four counters ("Automatické
 * články", "PDF", "Pripnuté články", "Obrázky"; "Zostáva X slotov" within the plan), every slot in order (drag and
 * drop or ↑ ↓; a file or post chosen for each), and the live preview on a phone and a computer before saving. The
 * database checks everything again (owner_save_content) and decides what visitors see.
 */
export function ContentEditor({
  shopId,
  settings,
  slots: initialSlots,
  limits,
  items,
  posts,
  text,
  lang,
  planUrl,
}: {
  shopId: string;
  /** `ratio` is missing before database update 44 (then neither "Pomer strán slidera" nor "Výrez" is offered). */
  settings: { title: string | null; showTitle: boolean; display: "open" | "collapsed"; videoTarget?: VideoTarget; ratio?: SliderRatio | null };
  slots: Slot[];
  limits: ContentLimits;
  items: EditorItem[];
  posts: EditorPost[];
  text: Text;
  lang: string;
  planUrl: string;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(settings.title ?? "");
  const [showTitle, setShowTitle] = useState(settings.showTitle);
  const [display, setDisplay] = useState(settings.display);
  const [videoTarget, setVideoTarget] = useState<VideoTarget>(settings.videoTarget ?? "post");
  const hasRatio = settings.ratio !== undefined;
  const [ratio, setRatio] = useState<SliderRatio>(settings.ratio ?? DEFAULT_RATIO);
  const [rows, setRows] = useState<Row[]>(() => initialSlots.map(withKey));
  const [dragging, setDragging] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [openKey, setOpenKey] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [device, setDevice] = useState<"mobile" | "desktop">("mobile");
  const list = useRef<HTMLOListElement>(null);
  // the last saved state ("Zrušiť" goes back to it; the save bar counts against it)
  const [base, setBase] = useState(() => ({
    title: settings.title ?? "",
    showTitle: settings.showTitle,
    display: settings.display,
    videoTarget: (settings.videoTarget ?? "post") as VideoTarget,
    ratio: (settings.ratio ?? DEFAULT_RATIO) as SliderRatio,
    rows: initialSlots as Slot[],
  }));

  // A shop back on free keeps what it stored; it may keep it, never add (the database checks the same).
  const stored = useMemo(() => ({ total: initialSlots.length, pdfs: initialSlots.filter((s) => s.kind === "pdf").length }), [initialSlots]);
  const allowed = {
    maxSlides: Math.min(MAX_SLIDES, Math.max(limits.maxSlides, stored.total)),
    maxPdfSlides: Math.max(limits.maxPdfSlides, stored.pdfs),
  };
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const postMap = useMemo(() => new Map(posts.map((p) => [p.id, p])), [posts]);
  const { counts, total, left } = slotCounts(rows, allowed);
  const shown = shownSlots(rows, itemMap, limits);
  const shownAt = new Set(shown.map((s) => s.index));
  const arranged = arrangeSlides(rows, itemMap, posts, limits);
  const autoFill = new Map(arranged.filter((a) => a.kind === "post" && a.auto).map((a) => [a.index, a.kind === "post" ? a.post : null]));

  const change = (next: Row[]) => {
    setRows(next);
    setMessage(null);
  };
  const add = (kind: SlotKind) => {
    if (!canAdd(rows, kind, allowed)) return;
    const used = new Set(rows.map((r) => r.item_id ?? r.post_id));
    const item = kind === "pdf" || kind === "picture" ? items.find((i) => i.kind === kind && !used.has(i.id)) : undefined;
    change([...rows, withKey({ kind, item_id: item?.id ?? null, post_id: null })]);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return;
    const next = [...rows];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    change(next);
  };
  const groupAuto = () => {
    const first = rows.findIndex((r) => r.kind === "auto_post");
    if (first < 0) return;
    const autos = rows.filter((r) => r.kind === "auto_post");
    const before = rows.slice(0, first).filter((r) => r.kind !== "auto_post");
    const after = rows.slice(first).filter((r) => r.kind !== "auto_post");
    change([...before, ...autos, ...after]);
  };
  const setChoice = (key: number, value: string) =>
    change(rows.map((r) => (r.key !== key ? r : r.kind === "pinned_post" ? { ...r, post_id: value || null } : { ...r, item_id: value || null })));
  const setCrop = (key: number, crop: Crop) => change(rows.map((r) => (r.key === key ? { ...r, crop } : r)));

  async function save() {
    setBusy(true);
    setMessage(null);
    const result = await saveContent({
      shopId,
      title,
      showTitle,
      display,
      // Before database update 39 there is no such setting (it is then neither shown nor sent).
      videoTarget: settings.videoTarget ? videoTarget : undefined,
      // Before database update 44 there is no ratio (and no "Výrez").
      ratio: hasRatio ? ratio : undefined,
      slots: rows.map(({ kind, item_id, post_id, crop }) => ({ kind, item_id, post_id, ...(hasRatio && crop && crop !== "center" ? { crop } : {}) })),
    }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    setBusy(false);
    if ("error" in result) {
      const known = (text as Record<string, string>)[`save_error_${result.error}`];
      setMessage({ ok: false, text: known ? fill(known, { max: limits.maxSlides, pdf: limits.maxPdfSlides }) : fill(text.save_failed, { message: result.error }) });
      return;
    }
    setBase({ title, showTitle, display, videoTarget, ratio, rows: rows.map(({ kind, item_id, post_id, crop }) => ({ kind, item_id, post_id, crop })) });
    setMessage({ ok: true, text: text.saved });
    router.refresh();
  }

  // What the slider shows with these (unsaved) settings: the same rule as the database.
  const previewViews: SlideView[] = arranged.flatMap((a): SlideView[] => {
    if (a.kind === "post") {
      const p = a.post;
      return [{ kind: "post", key: `${a.index}-${p.id}`, href: p.href, title: p.title, date: p.date, dateTime: p.dateTime, excerpt: p.excerpt, image: p.image, video: videoSlide(p.video, videoTarget, p.href) }];
    }
    const item = itemMap.get(a.itemId);
    if (!item?.image) return [];
    const crop = rows[a.index]?.crop ?? "center";
    if (a.kind === "pdf") {
      return [{ kind: "pdf", key: `${a.index}-${item.id}`, title: item.title, layout: item.layout, pages: Array.from({ length: Math.max(1, item.pages) }, () => ({ ...item.image!, text: "" })), download: null, crop }];
    }
    return [{ kind: "picture", key: `${a.index}-${item.id}`, title: item.showTitle ? item.title : null, alt: item.alt || item.title, image: item.image, text: "", download: null, crop }];
  });

  const reason = (row: Row, index: number): string | null => {
    if (shownAt.has(index)) {
      if (row.kind === "auto_post" && !autoFill.get(index)) return text.auto_empty;
      if (row.kind === "pinned_post" && (!row.post_id || !postMap.has(row.post_id))) return fill(text.not_shown, { reason: row.post_id ? text.reason_post : text.reason_empty });
      return null;
    }
    if ((row.kind === "pdf" || row.kind === "picture") && !row.item_id) return fill(text.not_shown, { reason: text.reason_empty });
    if ((row.kind === "pdf" || row.kind === "picture") && row.item_id && !itemMap.get(row.item_id)?.ready) return fill(text.not_shown, { reason: text.reason_hidden });
    const pdfsBefore = rows.slice(0, index + 1).filter((r, i) => r.kind === "pdf" && (shownAt.has(i) || (r.item_id && itemMap.get(r.item_id)?.ready))).length;
    if (row.kind === "pdf" && pdfsBefore > limits.maxPdfSlides) return fill(text.not_shown, { reason: text.reason_pdf_limit });
    return fill(text.not_shown, { reason: text.reason_limit });
  };

  const kindLabel: Record<SlotKind, string> = {
    auto_post: text.kind_auto_post,
    pinned_post: text.kind_pinned_post,
    pdf: text.kind_pdf,
    picture: text.kind_picture,
  };
  const plural = (prefix: string, n: number) => {
    const form = new Intl.PluralRules(lang).select(n);
    const t = text as Record<string, string>;
    return fill(t[`${prefix}_${form}`] ?? t[`${prefix}_other`], { n });
  };
  const leftText = plural("left", left);
  const input = fieldClass;
  const sliderTitle = title.trim() || text.default_title;

  // what changed against the last saved state: the settings one by one, the slots as one change ("Poradie zmenené"
  // when only their order moved)
  const sig = (r: Slot) => `${r.kind}:${r.item_id ?? ""}:${r.post_id ?? ""}:${r.crop ?? "center"}`;
  const nowSig = rows.map(sig);
  const baseSig = base.rows.map(sig);
  const slotsChanged = nowSig.join("|") !== baseSig.join("|");
  const orderOnly = slotsChanged && [...nowSig].sort().join("|") === [...baseSig].sort().join("|");
  const settingsChanged = [
    title !== base.title,
    showTitle !== base.showTitle,
    display !== base.display,
    hasRatio && ratio !== base.ratio,
    Boolean(settings.videoTarget) && videoTarget !== base.videoTarget,
  ].filter(Boolean).length;
  const changes = settingsChanged + (slotsChanged ? 1 : 0);
  const cancel = () => {
    setTitle(base.title);
    setShowTitle(base.showTitle);
    setDisplay(base.display);
    setRatio(base.ratio);
    setVideoTarget(base.videoTarget);
    setRows(base.rows.map(withKey));
    setOpenKey(null);
    setMessage(null);
  };

  // drag by the ⠿ handle (pointer events: a finger, a pen or a mouse); the order changes only in the browser until "Uložiť"
  const startDrag = (e: React.PointerEvent<HTMLButtonElement>, key: number) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(key);
  };
  const dragMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (dragging === null || !list.current) return;
    const items = [...list.current.querySelectorAll<HTMLElement>("[data-slot-index]")];
    const from = rows.findIndex((r) => r.key === dragging);
    let to = items.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (to < 0) to = items.length - 1;
    else if (to > from) to -= 1;
    if (from >= 0 && to !== from) move(from, to);
  };
  const endDrag = () => setDragging(null);

  const segment = <T extends string>(label: string, value: T, options: { value: T; label: string }[], set: (v: T) => void, attr: string) => (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-semibold">{label}</span>
      <div role="group" aria-label={label} className="flex gap-1 rounded-xl border border-[#D6D6D6] p-1" data-segment={attr}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => set(o.value)}
            className={`min-h-12 flex-1 rounded-[10px] px-2 text-[15px] font-bold ${value === o.value ? "bg-[#111] text-white" : "text-[#3D3D3D]"}`}
            data-choice={o.value}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
  const iconButton = "flex size-12 flex-none items-center justify-center rounded-xl border border-[#D6D6D6] bg-white disabled:opacity-40";
  const rowTitle = (row: Row, i: number): string => {
    const current = row.kind === "pinned_post" ? row.post_id : row.item_id;
    if (row.kind === "auto_post") {
      const auto = autoFill.get(i);
      return auto ? fill(text.auto_now, { title: auto.title }) : text.auto_empty;
    }
    if (row.kind === "pinned_post") return current ? (postMap.get(current)?.title ?? text.reason_post) : text.choose_post;
    const item = current ? itemMap.get(current) : null;
    if (!item) return row.kind === "pdf" ? text.choose_pdf : text.choose_picture;
    if (row.kind === "pdf") return `${item.title} · ${plural("pages", Math.max(1, item.pages))}`;
    const crop = row.crop ?? "center";
    return hasRatio ? `${item.title} · ${fill(text.slot_crop, { crop: crop === "top" ? text.crop_top : crop === "bottom" ? text.crop_bottom : text.crop_center })}` : item.title;
  };
  const full = total >= allowed.maxSlides;

  return (
    <div className={`flex flex-col gap-[18px] ${dragging !== null ? "select-none" : ""}`} data-content-editor>
      <div className="grid gap-[18px] lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {/* 1. "Nastavenia slidera": the look side by side, then the title and the video button */}
          <section className={`${cardClass} min-w-0`} aria-labelledby="content-settings" data-content-settings>
            <h2 id="content-settings" className="sr-only">
              {text.settings_title}
            </h2>
            <div className="grid gap-3.5 sm:grid-cols-2">
              {segment(
                text.display,
                display,
                [
                  { value: "open", label: text.display_open },
                  { value: "collapsed", label: text.display_collapsed },
                ],
                setDisplay,
                "display",
              )}
              {hasRatio &&
                segment(
                  text.ratio_short,
                  ratio,
                  SLIDER_RATIOS.map((r) => ({ value: r, label: r })),
                  setRatio,
                  "ratio",
                )}
            </div>
            {hasRatio && <p className="text-sm text-muted">{fill(text.fill_hint, { ratio, size: ratioSize(ratio) })}</p>}
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold">{text.section_title_label}</span>
              <input value={title} maxLength={80} placeholder={text.default_title} onChange={(e) => setTitle(e.target.value)} className={input} data-content-title />
              <span className="text-[13px] text-muted">{text.section_title_hint}</span>
            </label>
            <label className="flex min-h-14 items-center justify-between gap-3 text-base font-semibold">
              {text.show_title}
              <input type="checkbox" checked={showTitle} onChange={(e) => setShowTitle(e.target.checked)} className="ppi-toggle" data-content-show-title />
            </label>
            {settings.videoTarget && (
              <fieldset className="flex flex-col gap-1" data-video-target>
                <legend className="mb-1 text-sm font-semibold">{text.video_target}</legend>
                {(["post", "facebook"] as const).map((v) => (
                  <label key={v} className="flex min-h-11 items-start gap-2.5 py-1">
                    <input
                      type="radio"
                      name="content-video-target"
                      checked={videoTarget === v}
                      onChange={() => setVideoTarget(v)}
                      className="mt-1 h-5 w-5 flex-none accent-[#111]"
                      data-video-target-choice={v}
                    />
                    {v === "post" ? text.video_target_post : text.video_target_facebook}
                  </label>
                ))}
                <span className="text-[13px] text-muted">{text.video_target_hint}</span>
              </fieldset>
            )}
          </section>

          {/* 2. The slots: ⠿ · the kind · the title (a tap opens its editor) · ▲ ▼; "+ Pridať slot" */}
          <section className={`${cardClass} min-w-0 gap-0 py-1.5`} aria-labelledby="content-order" data-content-slots>
            <h2 id="content-order" className="sr-only">
              {text.order_title}
            </h2>
            {rows.length === 0 && <p className="py-4 text-sm text-muted">{text.empty_slots_new}</p>}
            <ol ref={list} className="flex flex-col">
              {rows.map((row, i) => {
                const used = new Set(rows.filter((r) => r.key !== row.key).map((r) => r.item_id ?? r.post_id));
                const note = reason(row, i);
                const options =
                  row.kind === "pinned_post"
                    ? posts.filter((p) => !used.has(p.id)).map((p) => ({ id: p.id, label: `${p.title} (${p.date})` }))
                    : row.kind === "pdf" || row.kind === "picture"
                      ? items.filter((it) => it.kind === row.kind && !used.has(it.id)).map((it) => ({ id: it.id, label: it.title }))
                      : [];
                const current = row.kind === "pinned_post" ? row.post_id : row.item_id;
                const open = openKey === row.key;
                return (
                  <li
                    key={row.key}
                    className={`flex flex-col border-b border-[#E4E4E4] last:border-b-0 ${dragging === row.key ? "bg-[#F7F7F7]" : ""}`}
                    data-slot={row.kind}
                    data-slot-index={i}
                  >
                    <div className="flex min-h-[68px] items-center gap-2.5">
                      <button
                        type="button"
                        aria-label={`${text.drag_handle}: ${i + 1}`}
                        title={text.drag}
                        onPointerDown={(e) => startDrag(e, row.key)}
                        onPointerMove={dragMove}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        className="flex size-12 flex-none cursor-grab touch-none items-center justify-center rounded-xl active:cursor-grabbing"
                        data-slot-handle
                      >
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="#5C5C5C" aria-hidden="true">
                          <circle cx="9" cy="6" r="1.6" />
                          <circle cx="15" cy="6" r="1.6" />
                          <circle cx="9" cy="12" r="1.6" />
                          <circle cx="15" cy="12" r="1.6" />
                          <circle cx="9" cy="18" r="1.6" />
                          <circle cx="15" cy="18" r="1.6" />
                        </svg>
                      </button>
                      <span className="hidden h-[26px] flex-none items-center rounded-[13px] border border-[#D6D6D6] px-2.5 text-[13px] font-bold sm:inline-flex" data-slot-kind>
                        {kindLabel[row.kind]}
                      </span>
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={`slot-edit-${row.key}`}
                        onClick={() => setOpenKey(open ? null : row.key)}
                        className="flex min-h-12 min-w-0 flex-1 flex-col items-start justify-center text-left"
                        data-slot-title
                      >
                        <span className="text-[13px] font-bold text-[#5C5C5C] sm:hidden">{kindLabel[row.kind]}</span>
                        <span className="w-full truncate text-base font-semibold">{rowTitle(row, i)}</span>
                        {note && row.kind !== "auto_post" && (
                          <span className="w-full truncate text-[13px] text-muted" data-slot-note>
                            {note}
                          </span>
                        )}
                      </button>
                      <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`${text.move_up}: ${i + 1}`} className={iconButton} data-slot-up>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2.4" aria-hidden="true">
                          <path d="M6 15l6-6 6 6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => move(i, i + 1)}
                        disabled={i === rows.length - 1}
                        aria-label={`${text.move_down}: ${i + 1}`}
                        className={iconButton}
                        data-slot-down
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2.4" aria-hidden="true">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                    </div>
                    {open && (
                      <div id={`slot-edit-${row.key}`} className="flex flex-col gap-2.5 pb-3.5 pl-[58px] pr-1" data-slot-edit>
                        {row.kind === "auto_post" ? (
                          <p className="text-sm text-muted">{text.order_hint}</p>
                        ) : options.length || current ? (
                          <select
                            value={current ?? ""}
                            onChange={(e) => setChoice(row.key, e.target.value)}
                            className={`${input} max-w-full bg-white`}
                            aria-label={`${i + 1}. ${kindLabel[row.kind]}`}
                            data-slot-choice
                          >
                            <option value="">{row.kind === "pdf" ? text.choose_pdf : row.kind === "picture" ? text.choose_picture : text.choose_post}</option>
                            {current && !options.some((o) => o.id === current) && (
                              <option value={current}>
                                {row.kind === "pinned_post" ? (postMap.get(current)?.title ?? text.reason_post) : (itemMap.get(current)?.title ?? "–")}
                              </option>
                            )}
                            {options.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-sm text-muted">{row.kind === "pdf" ? text.none_pdf : row.kind === "picture" ? text.none_picture : text.none_post}</span>
                        )}
                        {hasRatio && (row.kind === "pdf" || row.kind === "picture") && current && (
                          <label className="flex flex-col gap-1.5">
                            <span className="text-sm font-semibold">{text.crop_label}</span>
                            <select
                              value={row.crop ?? "center"}
                              onChange={(e) => setCrop(row.key, e.target.value as Crop)}
                              className={`${input} bg-white`}
                              aria-label={`${i + 1}. ${text.crop_label}`}
                              data-slot-crop
                            >
                              {CROPS.map((c) => (
                                <option key={c} value={c}>
                                  {c === "top" ? text.crop_top : c === "bottom" ? text.crop_bottom : text.crop_center}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            change(rows.filter((r) => r.key !== row.key));
                            setOpenKey(null);
                          }}
                          className="min-h-11 self-start rounded-xl border border-[#D6D6D6] bg-white px-3.5 font-bold"
                          data-slot-remove
                        >
                          {text.remove}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-col border-t border-[#E4E4E4]" data-slot-add>
              <button
                type="button"
                onClick={() => setAdding(!adding)}
                disabled={full}
                aria-expanded={adding}
                className="flex min-h-[60px] items-center justify-center text-base font-bold disabled:text-[#9A9A9A]"
                data-slot-add-open
              >
                {text.add_slot}
              </button>
              {adding && !full && (
                <div className="grid grid-cols-2 gap-2 pb-3" data-slot-add-kinds>
                  {SLOT_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => {
                        add(kind);
                        setAdding(false);
                      }}
                      disabled={!canAdd(rows, kind, allowed)}
                      className="min-h-12 rounded-xl border border-[#D6D6D6] bg-white px-2 text-[15px] font-bold disabled:opacity-40"
                      data-slot-add-kind={kind}
                    >
                      {kindLabel[kind]}
                    </button>
                  ))}
                </div>
              )}
              {full && (
                <p className="pb-3 text-center text-sm" data-slots-full>
                  {leftText}
                  {limits.plan === "free" && (
                    <>
                      {" · "}
                      <Link href={planUrl} className="underline underline-offset-4">
                        {text.go_pro}
                      </Link>
                    </>
                  )}
                </p>
              )}
            </div>
          </section>
          <div className="flex flex-col gap-2 text-sm">
            <p aria-live="polite" data-slots-left>
              {fill(text.total, { total, max: allowed.maxSlides })} · <span className="font-semibold">{leftText}</span>
            </p>
            {counts.auto_post > 1 && (
              <button type="button" onClick={groupAuto} className="min-h-11 self-start underline underline-offset-4" data-group-auto>
                {text.group_auto}
              </button>
            )}
            {limits.plan === "free" && (
              <p className="text-muted" data-free-limits>
                {fill(text.free_note, { max: limits.maxSlides, pdf: limits.maxPdfSlides })}{" "}
                <Link href={planUrl} className="underline underline-offset-4">
                  {text.go_pro}
                </Link>
              </p>
            )}
            {stored.total > limits.maxSlides && (
              <p className="rounded-xl border border-line p-3" data-downgraded>
                {text.downgraded}
              </p>
            )}
          </div>
        </div>

        {/* 3. "Náhľad": the live slider on a phone or a computer, scaled to the card */}
        <section className={`${cardClass} min-w-0`} aria-labelledby="content-preview" data-content-preview>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="content-preview" className="text-[17px] font-bold">
              {text.preview_title}
            </h2>
            <div role="group" aria-label={text.preview_device} className="flex gap-1 rounded-xl border border-[#D6D6D6] p-1" data-preview-device>
              {(["mobile", "desktop"] as const).map((dv) => (
                <button
                  key={dv}
                  type="button"
                  aria-pressed={device === dv}
                  onClick={() => setDevice(dv)}
                  className={`min-h-11 rounded-[10px] px-3 text-[15px] font-bold ${device === dv ? "bg-[#111] text-white" : "text-[#3D3D3D]"}`}
                  data-device={dv}
                >
                  {dv === "mobile" ? text.preview_phone : text.preview_desktop}
                </button>
              ))}
            </div>
          </div>
          {previewViews.length === 0 ? (
            <p className="rounded-xl border border-line p-3 text-sm" data-preview-empty>
              {text.preview_empty}
            </p>
          ) : (
            <figure className="flex min-w-0 flex-col items-center" data-preview={device} inert>
              <div className={`w-full overflow-hidden border border-[#D6D6D6] ${device === "mobile" ? "max-w-[260px] rounded-[20px]" : "rounded-xl"}`}>
                {device === "mobile" ? (
                  <ScaledPreview width={PHONE_WIDTH} padding={16}>
                    <ContentSlider views={previewViews} title={sliderTitle} showTitle={showTitle} display={display} allNews={null} labels={text} lang={lang} ratio={ratio} preview />
                  </ScaledPreview>
                ) : (
                  <ScaledPreview width={DESKTOP_WIDTH} padding={0}>
                    <ContentSlider views={previewViews} title={sliderTitle} showTitle={showTitle} display={display} allNews={null} labels={text} lang={lang} ratio={ratio} preview />
                  </ScaledPreview>
                )}
              </div>
            </figure>
          )}
          <p className="text-center text-[13px] text-muted">{text.preview_drag_hint}</p>
          <p className="text-[13px] text-muted">{text.preview_hint}</p>
        </section>
      </div>

      {/* the save bar (one call: owner_save_content) */}
      <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#E4E4E4] bg-white px-4 py-3 md:mx-0 md:px-0" data-save-bar>
        <span className="text-[15px] font-semibold" aria-live="polite" data-unsaved={changes}>
          {message && changes === 0 ? (
            <span role={message.ok ? "status" : "alert"} className={message.ok ? "" : "font-normal"} data-content-message={message.ok ? "ok" : "error"}>
              {message.text}
            </span>
          ) : changes === 0 ? (
            ""
          ) : settingsChanged === 0 && orderOnly ? (
            text.order_changed
          ) : (
            fill(text.unsaved_n, { n: changes })
          )}
        </span>
        <div className="flex gap-2.5">
          <button type="button" onClick={cancel} disabled={changes === 0 || busy} className={ghostClass} data-content-cancel>
            {text.cancel}
          </button>
          <button type="button" onClick={save} disabled={busy} aria-busy={busy} className={`${buttonClass} min-w-[180px]`} data-content-save>
            {busy ? text.saving : text.save}
          </button>
        </div>
      </div>
    </div>
  );
}
