import { Noto_Sans, Quicksand } from "next/font/google";

/**
 * The website's one typeface, at the owner's request: Quicksand (variable, 300–700), with the
 * Central European letters (latin-ext: Slovak, Hungarian, Czech…) preloaded. The Vietnamese letters (update 40) are in
 * the same CSS as their own unicode-range file, not preloaded: a browser downloads them only on a page that shows such
 * letters (one declaration only — a second Quicksand() would make every browser load the font twice). next/font
 * downloads it at build time and serves it from the site itself — a visitor's browser never asks Google for anything. Both root layouts (PPI's pages and a shop's own domain) put its
 * variable on <html>; globals.css uses it for every page. Code-like values (DNS records, keys) keep `font-mono`.
 */
export const quicksand = Quicksand({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-quicksand",
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
