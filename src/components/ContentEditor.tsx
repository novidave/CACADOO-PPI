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
  const [dirty, setDirty] = useState(false);

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
    setDirty(true);
    setMessage(null);
  };
  const add = (kind: SlotKind) => {
    if (!canAdd(rows, kind, allowed)) return;
    const used = new Set(rows.map((r) => r.item_id ?? r.post_id));
    const item = kind === "pdf" || kind === "picture" ? items.find((i) => i.kind === kind && !used.has(i.id)) : undefined;
    change([...rows, withKey({ kind, item_id: item?.id ?? null, post_id: null })]);
  };
  const removeLast = (kind: SlotKind) => {
    const at = rows.map((r) => r.kind).lastIndexOf(kind);
    if (at >= 0) change(rows.filter((_, i) => i !== at));
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
    setDirty(false);
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

  const counterLabel: Record<SlotKind, string> = {
    auto_post: text.count_auto_post,
    pdf: text.count_pdf,
    pinned_post: text.count_pinned_post,
    picture: text.count_picture,
  };
  const kindLabel: Record<SlotKind, string> = {
    auto_post: text.kind_auto_post,
    pinned_post: text.kind_pinned_post,
    pdf: text.kind_pdf,
    picture: text.kind_picture,
  };
  const leftForm = new Intl.PluralRules(lang).select(left);
  const leftText = fill(leftForm === "one" ? text.left_one : leftForm === "few" ? text.left_few : text.left_other, { n: left });
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const sliderTitle = title.trim() || text.default_title;

  return (
    <div className="flex flex-col gap-6" data-content-editor>
      {/* 1. The section's title and look */}
      <section className="flex flex-col gap-3" aria-labelledby="content-settings">
        <h3 id="content-settings" className="font-semibold">
          {text.settings_title}
        </h3>
        <label className="flex flex-col gap-1">
          <span className="text-sm">{text.section_title_label}</span>
          <input
            value={title}
            maxLength={80}
            placeholder={text.default_title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
            }}
            className={input}
            data-content-title
          />
          <span className="text-sm text-muted">{text.section_title_hint}</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showTitle}
            onChange={(e) => {
              setShowTitle(e.target.checked);
              setDirty(true);
            }}
            data-content-show-title
          />
          {text.show_title}
        </label>
        <fieldset className="flex flex-wrap gap-x-5 gap-y-1">
          <legend className="text-sm">{text.display}</legend>
          {(["open", "collapsed"] as const).map((d) => (
            <label key={d} className="flex items-center gap-2">
              <input
                type="radio"
                name="content-display"
                checked={display === d}
                onChange={() => {
                  setDisplay(d);
                  setDirty(true);
                }}
                data-content-display={d}
              />
              {d === "open" ? text.display_open : text.display_collapsed}
            </label>
          ))}
        </fieldset>
        {hasRatio && (
          <fieldset className="flex flex-col gap-1" data-slider-ratio>
            <legend className="text-sm">{text.ratio_title}</legend>
            {SLIDER_RATIOS.map((r) => (
              <label key={r} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="content-ratio"
                  checked={ratio === r}
                  onChange={() => {
                    setRatio(r);
                    setDirty(true);
                  }}
                  data-ratio-choice={r}
                />
                {r === "4:5" ? text.ratio_4_5 : r === "1:1" ? text.ratio_1_1 : text.ratio_16_9}
              </label>
            ))}
            <span className="text-sm text-muted">{fill(text.fill_hint, { ratio, size: ratioSize(ratio) })}</span>
          </fieldset>
        )}
        {settings.videoTarget && (
          <fieldset className="flex flex-col gap-1" data-video-target>
            <legend className="text-sm">{text.video_target}</legend>
            {(["post", "facebook"] as const).map((v) => (
              <label key={v} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="content-video-target"
                  checked={videoTarget === v}
                  onChange={() => {
                    setVideoTarget(v);
                    setDirty(true);
                  }}
                  className="mt-1"
                  data-video-target-choice={v}
                />
                {v === "post" ? text.video_target_post : text.video_target_facebook}
              </label>
            ))}
            <span className="text-sm text-muted">{text.video_target_hint}</span>
          </fieldset>
        )}
      </section>

      {/* 2. Quick setup: how many slots of each kind */}
      <section className="flex flex-col gap-3" aria-labelledby="content-quick">
        <h3 id="content-quick" className="font-semibold">
          {text.quick_title}
        </h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {SLOT_KINDS.map((kind) => (
            <li key={kind} className="flex items-center justify-between gap-3 border border-line px-3 py-2" data-counter={kind}>
              <span>{counterLabel[kind]}</span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => removeLast(kind)}
                  disabled={counts[kind] === 0}
                  aria-label={fill(text.remove_one, { kind: counterLabel[kind] })}
                  className="h-8 w-8 rounded border border-foreground text-lg leading-none disabled:border-line disabled:text-line"
                  data-counter-minus
                >
                  −
                </button>
                <span className="w-6 text-center font-semibold tabular-nums" data-counter-value>
                  {counts[kind]}
                </span>
                <button
                  type="button"
                  onClick={() => add(kind)}
                  disabled={!canAdd(rows, kind, allowed)}
                  aria-label={fill(text.add_one, { kind: counterLabel[kind] })}
                  className="h-8 w-8 rounded border border-foreground text-lg leading-none disabled:border-line disabled:text-line"
                  data-counter-plus
                >
                  +
                </button>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-sm" aria-live="polite" data-slots-left>
          {fill(text.total, { total, max: allowed.maxSlides })} · <span className="font-semibold">{leftText}</span>
        </p>
        {limits.plan === "free" && (
          <p className="text-sm text-muted" data-free-limits>
            {fill(text.free_note, { max: limits.maxSlides, pdf: limits.maxPdfSlides })}{" "}
            <Link href={planUrl} className="underline underline-offset-4">
              {text.go_pro}
            </Link>
          </p>
        )}
        {stored.total > limits.maxSlides && <p className="border border-line p-3 text-sm" data-downgraded>{text.downgraded}</p>}
      </section>

      {/* 3. The order of every slot */}
      <section className="flex flex-col gap-2" aria-labelledby="content-order">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="content-order" className="font-semibold">
            {text.order_title}
          </h3>
          {counts.auto_post > 1 && (
            <button type="button" onClick={groupAuto} className="text-sm underline underline-offset-4" data-group-auto>
              {text.group_auto}
            </button>
          )}
        </div>
        <p className="text-sm text-muted">{text.order_hint}</p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{text.empty_slots}</p>
        ) : (
          <ol className="divide-y divide-line border-y border-line">
            {rows.map((row, i) => {
              const used = new Set(rows.filter((r) => r.key !== row.key).map((r) => r.item_id ?? r.post_id));
              const note = reason(row, i);
              const auto = autoFill.get(i);
              const options =
                row.kind === "pinned_post"
                  ? posts.filter((p) => !used.has(p.id)).map((p) => ({ id: p.id, label: `${p.title} (${p.date})` }))
                  : row.kind === "pdf" || row.kind === "picture"
                    ? items.filter((it) => it.kind === row.kind && !used.has(it.id)).map((it) => ({ id: it.id, label: it.title }))
                    : [];
              const current = row.kind === "pinned_post" ? row.post_id : row.item_id;
              return (
                <li
                  key={row.key}
                  draggable
                  onDragStart={() => setDragging(row.key)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = rows.findIndex((r) => r.key === dragging);
                    setDragging(null);
                    if (from >= 0) move(from, i);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={`flex items-start gap-2 py-2 ${dragging === row.key ? "opacity-50" : ""}`}
                  data-slot={row.kind}
                  data-slot-index={i}
                >
                  <span className="cursor-grab select-none px-1 pt-1 text-muted" title={text.drag} aria-hidden="true">
                    ⋮⋮
                  </span>
                  <span className="w-6 pt-1 text-right text-sm tabular-nums text-muted">{i + 1}.</span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="font-semibold">{kindLabel[row.kind]}</span>
                    {row.kind === "auto_post" ? (
                      <span className="text-sm text-muted" data-auto-now>
                        {auto ? fill(text.auto_now, { title: auto.title }) : text.auto_empty}
                      </span>
                    ) : options.length || current ? (
                      <select
                        value={current ?? ""}
                        onChange={(e) => setChoice(row.key, e.target.value)}
                        className={`${input} max-w-full`}
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
                      <label className="flex flex-wrap items-center gap-2 text-sm">
                        <span>{text.crop_label}</span>
                        <select
                          value={row.crop ?? "center"}
                          onChange={(e) => setCrop(row.key, e.target.value as Crop)}
                          className="rounded border border-line px-2 py-1 outline-none focus:border-foreground"
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
                    {note && row.kind !== "auto_post" && (
                      <span className="text-sm text-muted" data-slot-note>
                        {note}
                      </span>
                    )}
                  </div>
                  <span className="flex flex-col text-sm">
                    <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`${text.move_up}: ${i + 1}`} className="px-1 disabled:text-line">
                      ↑
                    </button>
                    <button type="button" onClick={() => move(i, i + 1)} disabled={i === rows.length - 1} aria-label={`${text.move_down}: ${i + 1}`} className="px-1 disabled:text-line">
                      ↓
                    </button>
                  </span>
                  <button
                    type="button"
                    onClick={() => change(rows.filter((r) => r.key !== row.key))}
                    aria-label={`${text.remove}: ${i + 1}`}
                    className="px-1 pt-1 text-lg leading-none"
                    data-slot-remove
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy} className="rounded border border-foreground bg-foreground px-4 py-2 font-medium text-white disabled:opacity-60" data-content-save>
          {busy ? text.saving : text.save}
        </button>
        {dirty && !message && <span className="text-sm text-muted">{text.unsaved}</span>}
        {message && (
          <span role={message.ok ? "status" : "alert"} className={message.ok ? "font-medium" : ""} data-content-message={message.ok ? "ok" : "error"}>
            {message.text}
          </span>
        )}
      </div>

      {/* 4. Live preview, as visitors would see it with these settings */}
      <section className="flex flex-col gap-3" aria-labelledby="content-preview">
        <h3 id="content-preview" className="font-semibold">
          {text.preview_title}
        </h3>
        <p className="text-sm text-muted">{text.preview_hint}</p>
        {previewViews.length === 0 ? (
          <p className="border border-line p-3 text-sm" data-preview-empty>
            {text.preview_empty}
          </p>
        ) : (
          // Always one under the other: the phone first, then the computer (both at their real width, scaled to fit).
          <div className="flex flex-col gap-4" data-previews>
            <figure className="flex min-w-0 flex-col gap-1" data-preview="mobile">
              <figcaption className="text-xs uppercase tracking-wide text-muted">{text.preview_mobile}</figcaption>
              <div className="w-fit max-w-full border border-line">
                <ScaledPreview width={PHONE_WIDTH} padding={16}>
                  <ContentSlider views={previewViews} title={sliderTitle} showTitle={showTitle} display={display} allNews={null} labels={text} lang={lang} ratio={ratio} preview />
                </ScaledPreview>
              </div>
            </figure>
            <figure className="flex min-w-0 flex-col gap-1" data-preview="desktop">
              <figcaption className="text-xs uppercase tracking-wide text-muted">{text.preview_desktop}</figcaption>
              <div className="w-full border border-line">
                <ScaledPreview width={DESKTOP_WIDTH} padding={0}>
                  <ContentSlider views={previewViews} title={sliderTitle} showTitle={showTitle} display={display} allNews={null} labels={text} lang={lang} ratio={ratio} preview />
                </ScaledPreview>
              </div>
            </figure>
          </div>
        )}
      </section>
    </div>
  );
}
