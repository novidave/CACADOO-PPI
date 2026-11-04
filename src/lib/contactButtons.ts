/**
 * The shop page's contact buttons (database update 51): which buttons a shop shows, in which order, with which colour,
 * link and width. Shared by the shop page, Môj obchod and `contactButtons_test.ts`; no React here.
 *
 * Order (two columns): Facebook · Rezervovať termín / Web · e-mail / Navigovať · phone. A button without its link or
 * value is not shown and the rest move up. Width: "short" = one column, "long" = both; the owner's choice is stored in
 * `shops.contact_buttons`, a button without a choice uses DEFAULT_WIDTHS. A short button followed by a long one stays
 * in the left column (the grid's normal flow); nothing is reordered.
 */

export const CONTACT_KEYS = ["facebook", "booking", "web", "email", "navigate", "phone"] as const;
export type ContactKey = (typeof CONTACT_KEYS)[number];
export type ContactWidth = "short" | "long";
export type ContactWidths = Record<ContactKey, ContactWidth>;

/** The buttons' colours (the owner's exception to "no colours", 2026-10-28). */
export const CONTACT_COLORS: Record<ContactKey, string> = {
  facebook: "#1877F2",
  booking: "#E2602E",
  web: "#7A3FD1",
  email: "#0E8A8A",
  navigate: "#D08A0E",
  phone: "#1E9E4F",
};

export const DEFAULT_WIDTHS: ContactWidths = {
  facebook: "short",
  booking: "short",
  web: "short",
  email: "long",
  navigate: "short",
  phone: "short",
};

/** How long the button must be held before it acts, and how long "done" stays (ms): the hold links' rule. */
export { DONE_MS, HOLD_MS } from "./holdLink";

/** The stored choices (anything else, or nothing, = the defaults). */
export function contactWidths(stored: unknown): ContactWidths {
  const out = { ...DEFAULT_WIDTHS };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const key of CONTACT_KEYS) {
      const value = (stored as Record<string, unknown>)[key];
      if (value === "short" || value === "long") out[key] = value;
    }
  }
  return out;
}

/** What Môj obchod saves: only the choices that differ from the default (the defaults may change later). */
export function widthChoices(widths: Partial<Record<ContactKey, unknown>>): Partial<ContactWidths> {
  const out: Partial<ContactWidths> = {};
  for (const key of CONTACT_KEYS) {
    const value = widths[key];
    if ((value === "short" || value === "long") && value !== DEFAULT_WIDTHS[key]) out[key] = value;
  }
  return out;
}

export interface ContactShop {
  /** the shop's name as written (the geo: link's label on Android) */
  name?: string | null;
  facebook_url: string | null;
  booking_url: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  city: string | null;
  country: string | null;
  zip?: string | null;
}

/**
 * Directions: to the shop's map position when it has one (exact, no address lookup), else to its written address;
 * null when it has neither.
 */
export function navigateHref(shop: Pick<ContactShop, "lat" | "lng" | "address" | "city" | "country" | "zip">): string | null {
  const base = "https://www.google.com/maps/dir/?api=1&destination=";
  if (shop.lat !== null && shop.lng !== null) return `${base}${shop.lat},${shop.lng}`;
  const town = [shop.zip, shop.city].map((p) => p?.trim()).filter(Boolean).join(" ");
  const parts = [shop.address, town, shop.country].map((p) => p?.trim()).filter(Boolean);
  if (!shop.address?.trim() && !shop.city?.trim()) return null;
  return base + encodeURIComponent(parts.join(", "));
}

/** An Android phone (from the request's user agent; decided on the server, so the page's first HTML is right). */
export function isAndroid(userAgent: string | null | undefined): boolean {
  return /\bAndroid\b/i.test(userAgent ?? "");
}

/**
 * Directions on Android (2026-11-04): `geo:<lat>,<lng>?q=<lat>,<lng>(<name>)` — Android hands it to the Maps app (or
 * lets the visitor choose a map app); the name is URL-encoded, "(" and ")" too (they would end the label). Only with
 * the shop's map position; without one null (the Google Maps link stays).
 */
export function geoHref(shop: Pick<ContactShop, "lat" | "lng" | "name">): string | null {
  if (shop.lat === null || shop.lng === null || shop.lat === undefined || shop.lng === undefined) return null;
  const name = encodeURIComponent((shop.name ?? "").trim()).replace(/[()!'*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `geo:${shop.lat},${shop.lng}?q=${shop.lat},${shop.lng}${name ? `(${name})` : ""}`;
}

export interface ContactLabels {
  facebook: string;
  booking: string;
  web: string;
  navigate: string;
}

export interface ContactButtonData {
  key: ContactKey;
  href: string;
  /** The idle label (also the aria-label): the e-mail address and the phone number as written. */
  label: string;
  newTab: boolean;
  width: ContactWidth;
  color: string;
}

/**
 * The buttons a shop shows, in the page's order. Shop data is shown as written (only spaces removed from tel:).
 * `android` (from `isAndroid()` of the request): Navigovať is a geo: link when the shop has a map position (the same
 * tab; Android opens the Maps app); iPhones and computers keep the Google Maps link.
 */
export function contactButtons(shop: ContactShop, widths: ContactWidths, labels: ContactLabels, device: { android?: boolean } = {}): ContactButtonData[] {
  const value = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const phone = value(shop.phone);
  const email = value(shop.email);
  const geo = device.android ? geoHref(shop) : null;
  const links: Record<ContactKey, { href: string | null; label: string; newTab: boolean }> = {
    facebook: { href: value(shop.facebook_url), label: labels.facebook, newTab: true },
    booking: { href: value(shop.booking_url), label: labels.booking, newTab: true },
    web: { href: value(shop.website), label: labels.web, newTab: true },
    email: { href: email ? `mailto:${email}` : null, label: email ?? "", newTab: false },
    navigate: geo ? { href: geo, label: labels.navigate, newTab: false } : { href: navigateHref(shop), label: labels.navigate, newTab: true },
    phone: { href: phone ? `tel:${phone.replace(/\s+/g, "")}` : null, label: phone ?? "", newTab: false },
  };
  return CONTACT_KEYS.flatMap((key) => {
    const link = links[key];
    return link.href ? [{ key, href: link.href, label: link.label, newTab: link.newTab, width: widths[key], color: CONTACT_COLORS[key] }] : [];
  });
}

/** Where each button lands in the two columns (the grid's normal flow; for the tests and the docs). */
export function gridPlaces(buttons: { width: ContactWidth }[]): { row: number; column: 1 | 2; span: 1 | 2 }[] {
  let row = 1;
  let column: 1 | 2 = 1;
  return buttons.map((b) => {
    if (b.width === "long") {
      if (column === 2) row += 1;
      const place = { row, column: 1 as const, span: 2 as const };
      row += 1;
      column = 1;
      return place;
    }
    const place = { row, column, span: 1 as const };
    if (column === 2) {
      row += 1;
      column = 1;
    } else column = 2;
    return place;
  });
}

/**
 * A label that would not fit at 15 px is set at 12.5 px (never cut, never wrapped): decided from the longest of its
 * texts (the label, "Držte stlačené", "Pustite" and the done label with their check), in characters of Quicksand 600 —
 * a short button holds about 16 at 15 px on a 390 px phone, a long one about 36.
 */
export function smallLabel(texts: { label: string; hold: string; release?: string; done: string }, width: ContactWidth): boolean {
  const longest = Math.max([...texts.label].length, [...texts.hold].length, [...(texts.release ?? "")].length + 4, [...texts.done].length + 4);
  return longest > (width === "long" ? 36 : 16);
}
