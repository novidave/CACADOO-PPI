/**
 * "Obsah stránky" (database update 38): one slider on the shop page with blog posts, PDFs and pictures in the owner's
 * order. The database decides what visitors see (shop_content(): content_slots_shown, the blog's visibility, public
 * pictures); arrangeSlides() is the same rule for the editor's live preview, from the editor's unsaved slots. Shared
 * by the server, the browser and the tests (no server-only imports here).
 */

import type { PostVideo, VideoTarget } from "./video";

export type SlotKind = "auto_post" | "pinned_post" | "pdf" | "picture";
export const SLOT_KINDS: SlotKind[] = ["auto_post", "pdf", "pinned_post", "picture"];
/** The slider's hard maximum (the admin's Pro number may be lower). */
export const MAX_SLIDES = 10;

export interface Slot {
  kind: SlotKind;
  item_id: string | null;
  post_id: string | null;
  /** "Výrez" of a picture or PDF slide (update 44; missing = center). */
  crop?: Crop;
}

// ---------------------------------------------------------------- the fixed frame (update 44)

/** "Pomer strán slidera": every slide has the same frame; null / missing = 4:5 (1080 × 1350 px uploads). */
export type SliderRatio = "4:5" | "1:1" | "16:9";
export const SLIDER_RATIOS: SliderRatio[] = ["4:5", "1:1", "16:9"];
export const DEFAULT_RATIO: SliderRatio = "4:5";

/** "Výrez": which part of a picture stays visible when it does not have the frame's ratio. */
export type Crop = "top" | "center" | "bottom";
export const CROPS: Crop[] = ["top", "center", "bottom"];

export function sliderRatio(value: unknown): SliderRatio {
  return SLIDER_RATIOS.includes(value as SliderRatio) ? (value as SliderRatio) : DEFAULT_RATIO;
}

export function slideCrop(value: unknown): Crop {
  return CROPS.includes(value as Crop) ? (value as Crop) : "center";
}

/** The frame's width ÷ height (4:5 → 0.8). */
export function ratioValue(ratio: SliderRatio): number {
  const [w, h] = ratio.split(":").map(Number);
  return w / h;
}

/** CSS aspect-ratio of the frame ("4 / 5"). */
export function ratioCss(ratio: SliderRatio): string {
  return ratio.replace(":", " / ");
}

/** CSS object-position of a "Výrez". */
export function cropPosition(crop: Crop): string {
  return crop === "top" ? "50% 0%" : crop === "bottom" ? "50% 100%" : "50% 50%";
}

/** A suggested upload size for a ratio ("1080 × 1350"), shown in the upload hint. */
export function ratioSize(ratio: SliderRatio): string {
  return ratio === "1:1" ? "1080 × 1080" : ratio === "16:9" ? "1600 × 900" : "1080 × 1350";
}

export interface ContentLimits {
  plan: "free" | "pro";
  maxSlides: number;
  maxPdfSlides: number;
  maxItems: number;
  maxPages: number;
  maxBytes: number;
}

/** A blog photo as the database gives it (blog_photo_list): paths in the public bucket "blog-photos". */
export interface PostPhoto {
  kind: "photo" | "video";
  large: string;
  small: string;
  width: number | null;
  height: number | null;
}

export interface ContentPost {
  id: string;
  slug: string;
  title: string;
  /** The beginning of the text, as written (the card shows two lines of it). */
  excerpt: string;
  publish_at: string;
  source: "cacaduu" | "facebook";
  photo: PostPhoto | null;
  /** Its video (update 39; missing before it). */
  video?: PostVideo | null;
}

export interface ContentPage {
  page: number;
  width: number;
  height: number;
  ext: "webp" | "jpg";
  text: string;
}

export interface ContentItem {
  id: string;
  title: string;
  show_title: boolean;
  alt: string | null;
  version: number;
  page_layout: "slider" | "stacked";
  source: "pdf" | "pictures";
  download: boolean;
  pages: ContentPage[];
}

export type Slide =
  | { kind: "post"; auto: boolean; post: ContentPost }
  | { kind: "pdf" | "picture"; item: ContentItem; crop?: Crop };

/** shop_content(): the section's settings and its slides in order. */
export interface PageContent {
  title: string | null;
  show_title: boolean;
  display: "open" | "collapsed";
  /** "Tlačidlo ▶ pri videách otvorí" (update 39; missing before it = the article). */
  video_target?: VideoTarget;
  /** "Pomer strán slidera" (update 44; missing before it = 4:5). */
  ratio?: SliderRatio;
  has_posts: boolean;
  slides: Slide[];
}

/** A file of the library as the editor knows it (owner_content). */
export interface LibraryItem {
  id: string;
  kind: "pdf" | "picture";
  /** Uploaded, not hidden, inside its dates (section_item_ready). */
  ready: boolean;
}

/**
 * The slots shown, in order: every automatic or pinned slot counts, and every slot whose file is ready and of the
 * slot's kind; PDFs over the plan's number of PDFs are skipped; the first maxSlides are kept (as
 * content_slots_shown() in the database).
 */
export function shownSlots(slots: Slot[], items: Map<string, LibraryItem>, limits: Pick<ContentLimits, "maxSlides" | "maxPdfSlides">) {
  const out: { slot: Slot; index: number }[] = [];
  let pdfs = 0;
  slots.forEach((slot, index) => {
    if (out.length >= limits.maxSlides) return;
    if (slot.kind === "pdf" || slot.kind === "picture") {
      const item = slot.item_id ? items.get(slot.item_id) : undefined;
      if (!item || !item.ready || item.kind !== slot.kind) return;
      if (slot.kind === "pdf") {
        pdfs++;
        if (pdfs > limits.maxPdfSlides) return;
      }
    }
    out.push({ slot, index });
  });
  return out;
}

export type ArrangedSlide<P> =
  | { kind: "post"; auto: boolean; post: P; index: number }
  | { kind: "pdf" | "picture"; itemId: string; index: number };

/**
 * What the slider shows (as shop_content()): pinned slots their visible post, automatic slots the newest visible
 * posts that are not pinned in a shown slot (fewer posts → fewer slides, never an empty one), file slots their file.
 * `posts`: the visible posts, newest first. `index` is the slot's place in the owner's list.
 */
export function arrangeSlides<P extends { id: string }>(
  slots: Slot[],
  items: Map<string, LibraryItem>,
  posts: P[],
  limits: Pick<ContentLimits, "maxSlides" | "maxPdfSlides">,
): ArrangedSlide<P>[] {
  const shown = shownSlots(slots, items, limits);
  const visible = new Map(posts.map((p) => [p.id, p]));
  const pinned = new Set(shown.filter((s) => s.slot.kind === "pinned_post" && s.slot.post_id && visible.has(s.slot.post_id)).map((s) => s.slot.post_id!));
  const queue = posts.filter((p) => !pinned.has(p.id));
  let next = 0;
  const out: ArrangedSlide<P>[] = [];
  for (const { slot, index } of shown) {
    if (slot.kind === "auto_post") {
      const post = queue[next++];
      if (post) out.push({ kind: "post", auto: true, post, index });
    } else if (slot.kind === "pinned_post") {
      const post = slot.post_id ? visible.get(slot.post_id) : undefined;
      if (post) out.push({ kind: "post", auto: false, post, index });
    } else if (slot.item_id) {
      out.push({ kind: slot.kind, itemId: slot.item_id, index });
    }
  }
  return out;
}

/** How many slots of each kind, and how many more the plan allows ("Zostáva X slotov"). */
export function slotCounts(slots: Slot[], limits: Pick<ContentLimits, "maxSlides" | "maxPdfSlides">) {
  const counts = { auto_post: 0, pinned_post: 0, pdf: 0, picture: 0 } as Record<SlotKind, number>;
  for (const s of slots) counts[s.kind]++;
  return { counts, total: slots.length, left: Math.max(0, Math.min(limits.maxSlides, MAX_SLIDES) - slots.length) };
}

/** Whether one more slot of a kind fits the plan (a free shop: 5 slides, 1 PDF by default). */
export function canAdd(slots: Slot[], kind: SlotKind, limits: Pick<ContentLimits, "maxSlides" | "maxPdfSlides">): boolean {
  const { counts, left } = slotCounts(slots, limits);
  return left > 0 && (kind !== "pdf" || counts.pdf < limits.maxPdfSlides);
}

// ---------------------------------------------------------------- what the slider draws

export interface SlideImage {
  small: string;
  large: string;
  /** The large picture's size (the small one has the same proportions, at most 800 px wide). */
  width: number;
  height: number;
}

export type SlideView =
  | {
      kind: "post";
      key: string;
      href: string;
      title: string;
      /** "20. 10. 2026", in the shop's time zone. */
      date: string;
      dateTime: string;
      excerpt: string;
      image: SlideImage | null;
      /** A video post (update 39): where its ▶ leads; `facebook` = to the post on Facebook. */
      video: { href: string; external: boolean; facebook: boolean } | null;
    }
  | {
      kind: "pdf";
      key: string;
      title: string;
      layout: "slider" | "stacked";
      pages: (SlideImage & { text: string })[];
      download: string | null;
      crop: Crop;
    }
  | {
      kind: "picture";
      key: string;
      /** Only when the owner gave the picture a title. */
      title: string | null;
      alt: string;
      image: SlideImage;
      text: string;
      download: string | null;
      crop: Crop;
    };

/** A file's page picture: 800 px wide (never more than the picture itself) and 1600 px. */
export function pageImage(page: Pick<ContentPage, "width" | "height">, small: string, large: string): SlideImage {
  return { small, large, width: page.width, height: page.height };
}

/** srcset for a picture that may be narrower than 800 px (a picture is never made larger: one file then). */
export function srcSet(image: SlideImage): string | undefined {
  return image.width > 800 ? `${image.small} 800w, ${image.large} ${image.width}w` : undefined;
}

/** The first two lines' worth of a post's text, as written (cut at a word). */
export function cardExcerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:–-]+$/, "")}…`;
}
