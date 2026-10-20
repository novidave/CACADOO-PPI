"use client";

import Image from "next/image";

/**
 * One photo of a blog post through next/image, straight from the bucket: its own loader picks the stored WebP 800 px
 * wide up to 800 and the 1600 px one above (1x / 2x by the shown width); nothing goes through image optimisation.
 */
export function BlogPhoto({
  large,
  small,
  width,
  height,
  shown,
  alt,
  className,
  preload = false,
}: {
  large: string;
  small: string;
  width: number | null;
  height: number | null;
  /** The width the page shows it at (px). */
  shown: number;
  alt: string;
  className?: string;
  preload?: boolean;
}) {
  const ratio = width && height ? height / width : 0.75;
  return (
    <Image
      src={large}
      loader={({ width: w }) => (w <= 800 ? small : large)}
      width={shown}
      height={Math.max(1, Math.round(shown * ratio))}
      alt={alt}
      className={className}
      preload={preload}
      loading={preload ? "eager" : "lazy"}
    />
  );
}
