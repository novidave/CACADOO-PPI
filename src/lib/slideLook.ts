/**
 * The slider's look (Screen 11): the frame, the crop, srcset and the tag — the only parts of "Obsah stránky" the
 * shop page's browser code needs (`@/components/ContentSlider`), so the rest of `@/lib/pageContent` (the slot rules,
 * excerpts, reading time) never joins the shop page's first JavaScript (the 150 kB budget). No imports.
 */

/** "Pomer strán slidera": every slide has the same frame; null / missing = 4:5 (1080 × 1350 px uploads). */
export type SliderRatio = "4:5" | "1:1" | "16:9";
export const DEFAULT_RATIO: SliderRatio = "4:5";

/** "Výrez": which part of a picture stays visible when it does not have the frame's ratio. */
export type Crop = "top" | "center" | "bottom";

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
      /** Update 93: the cover's crop. */
      crop?: Crop;
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

/** srcset for a picture that may be narrower than 800 px (a picture is never made larger: one file then). */
export function srcSet(image: SlideImage): string | undefined {
  return image.width > 800 ? `${image.small} 800w, ${image.large} ${image.width}w` : undefined;
}

/** The slide's tag on the picture: a post is news ("Novinka"), a PDF or a picture an offer ("Ponuka"). */
export function slideTag(kind: SlideView["kind"]): "tag_post" | "tag_offer" {
  return kind === "post" ? "tag_post" : "tag_offer";
}
