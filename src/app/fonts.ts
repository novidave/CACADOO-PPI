import { Noto_Sans, Quicksand } from "next/font/google";

/**
 * The website's one typeface, at the owner's request: Quicksand (variable, 300–700), with the
 * Central European letters (latin-ext: Slovak, Hungarian, Czech…) preloaded; the Vietnamese letters (update 40) come
 * from `quicksandVi` below, only on pages that use them. next/font downloads it at build time and serves it from the site itself — a
 * visitor's browser never asks Google for anything. Both root layouts (PPI's pages and a shop's own domain) put its
 * variable on <html>; globals.css uses it for every page. Code-like values (DNS records, keys) keep `font-mono`.
 */
export const quicksand = Quicksand({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-quicksand",
});

/**
 * Quicksand's Vietnamese letters as their own, not preloaded files: split by unicode-range, a browser downloads them
 * only on a page that shows such letters (the Latin pages no longer preload them).
 */
export const quicksandVi = Quicksand({
  subsets: ["vietnamese"],
  display: "swap",
  preload: false,
  variable: "--font-quicksand-vi",
});

/**
 * Quicksand has no Cyrillic or Greek letters (Українська, Български, Српски, Македонски, Ελληνικά): Noto Sans for
 * those only. Not preloaded, and its files are split by unicode-range, so a browser downloads them only on a page
 * that shows such letters. Chinese uses the visitor's system fonts (globals.css): no CJK web font is downloaded.
 */
export const notoFallback = Noto_Sans({
  subsets: ["cyrillic", "cyrillic-ext", "greek"],
  display: "swap",
  preload: false,
  variable: "--font-noto",
});
