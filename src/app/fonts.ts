import { Quicksand } from "next/font/google";

/**
 * The website's one typeface, at the owner's request: Quicksand (variable, 300–700), with the
 * Central European letters (latin-ext: Slovak, Hungarian, Czech…). next/font downloads it at build
 * time and serves it from the site itself — a visitor's browser never asks Google for anything.
 * Both root layouts (PPI's pages and a shop's own domain) put its variable on <html>; globals.css
 * uses it for every page. Code-like values (DNS records, keys) keep Tailwind's `font-mono`.
 */
export const quicksand = Quicksand({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-quicksand",
});
