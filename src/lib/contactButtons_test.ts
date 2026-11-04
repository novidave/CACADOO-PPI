// Unit tests (Deno) of the shop page's contact buttons (database update 51): order, hidden empty buttons, links,
// widths and their defaults, where the buttons land in the two columns, directions by position or address, and
// Navigovať on Android = a geo: link (2026-11-04, decided from the request's user agent).
// Run: npm run test:site
import { assertEquals } from "jsr:@std/assert@1";
import {
  CONTACT_COLORS,
  contactButtons,
  contactWidths,
  DEFAULT_WIDTHS,
  geoHref,
  gridPlaces,
  isAndroid,
  navigateHref,
  smallLabel,
  widthChoices,
  type ContactShop,
} from "./contactButtons.ts";

const labels = { facebook: "Facebook", booking: "Rezervovať termín", web: "Web", navigate: "Navigovať" };
const full: ContactShop = {
  name: "Farby Košice",
  facebook_url: "https://www.facebook.com/farby",
  booking_url: "https://booking.example.com/farby",
  website: "https://farby.example.sk",
  email: "obchod@farby.sk",
  phone: "+421 905 123 456",
  lat: 48.72,
  lng: 21.26,
  address: "Hlavná 1",
  city: "Košice",
  country: "SK",
  zip: "040 01",
};

Deno.test("the six buttons in the page's order, with their colours and links", () => {
  const buttons = contactButtons(full, DEFAULT_WIDTHS, labels);
  assertEquals(buttons.map((b) => b.key), ["facebook", "booking", "web", "email", "navigate", "phone"]);
  assertEquals(buttons.map((b) => b.label), ["Facebook", "Rezervovať termín", "Web", "obchod@farby.sk", "Navigovať", "+421 905 123 456"]);
  assertEquals(buttons.find((b) => b.key === "phone")?.href, "tel:+421905123456");
  assertEquals(buttons.find((b) => b.key === "email")?.href, "mailto:obchod@farby.sk");
  assertEquals(buttons.find((b) => b.key === "email")?.newTab, false);
  assertEquals(buttons.find((b) => b.key === "web")?.newTab, true);
  assertEquals(buttons.find((b) => b.key === "facebook")?.color, CONTACT_COLORS.facebook);
});

Deno.test("a button without its link or value is not shown; the rest move up", () => {
  const buttons = contactButtons({ ...full, facebook_url: null, booking_url: "  ", email: "" }, DEFAULT_WIDTHS, labels);
  assertEquals(buttons.map((b) => b.key), ["web", "navigate", "phone"]);
  const none = contactButtons(
    { ...full, facebook_url: null, booking_url: null, website: null, email: null, phone: null, lat: null, lng: null, address: null, city: null },
    DEFAULT_WIDTHS,
    labels,
  );
  assertEquals(none, []);
});

Deno.test("directions go to the map position, else to the written address", () => {
  assertEquals(navigateHref(full), "https://www.google.com/maps/dir/?api=1&destination=48.72,21.26");
  assertEquals(
    navigateHref({ ...full, lat: null, lng: null }),
    "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent("Hlavná 1, 040 01 Košice, SK"),
  );
  assertEquals(navigateHref({ ...full, lat: null, lng: null, address: null, city: null }), null);
});

const UA = {
  pixel: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  firefox: "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

Deno.test("Android from the user agent: phones and tablets with Android only", () => {
  assertEquals([UA.pixel, UA.samsung, UA.firefox].map(isAndroid), [true, true, true]);
  assertEquals([UA.iphone, UA.ipad, UA.windows, UA.linux, "", null, undefined].map(isAndroid), [false, false, false, false, false, false, false]);
});

Deno.test("Navigovať on Android with a map position = geo: with the shop's name (the Maps app), in this tab", () => {
  const nav = contactButtons(full, DEFAULT_WIDTHS, labels, { android: isAndroid(UA.pixel) }).find((b) => b.key === "navigate")!;
  assertEquals(nav.href, "geo:48.72,21.26?q=48.72,21.26(Farby%20Ko%C5%A1ice)");
  assertEquals(nav.newTab, false);
  // the name is URL-encoded, brackets too (they would end the label)
  assertEquals(geoHref({ lat: 48.1, lng: 17.1, name: "Ján & syn (Farby) 100%" }), "geo:48.1,17.1?q=48.1,17.1(J%C3%A1n%20%26%20syn%20%28Farby%29%20100%25)");
  // no name: the point only
  assertEquals(geoHref({ lat: 48.1, lng: 17.1, name: " " }), "geo:48.1,17.1?q=48.1,17.1");
  // the other buttons keep their links
  const android = contactButtons(full, DEFAULT_WIDTHS, labels, { android: true });
  const other = contactButtons(full, DEFAULT_WIDTHS, labels);
  assertEquals(android.filter((b) => b.key !== "navigate"), other.filter((b) => b.key !== "navigate"));
});

Deno.test("Navigovať without a map position, on an iPhone or a computer = the Google Maps link as before", () => {
  const noPoint = contactButtons({ ...full, lat: null, lng: null }, DEFAULT_WIDTHS, labels, { android: true }).find((b) => b.key === "navigate")!;
  assertEquals(noPoint.href, "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent("Hlavná 1, 040 01 Košice, SK"));
  assertEquals(noPoint.newTab, true);
  assertEquals(geoHref({ lat: null, lng: null, name: "x" }), null);
  for (const ua of [UA.iphone, UA.ipad, UA.windows, UA.linux]) {
    const nav = contactButtons(full, DEFAULT_WIDTHS, labels, { android: isAndroid(ua) }).find((b) => b.key === "navigate")!;
    assertEquals(nav.href, "https://www.google.com/maps/dir/?api=1&destination=48.72,21.26");
    assertEquals(nav.newTab, true);
  }
  // nothing to navigate to: no button, on Android too
  const none = contactButtons({ ...full, lat: null, lng: null, address: null, city: null }, DEFAULT_WIDTHS, labels, { android: true });
  assertEquals(none.some((b) => b.key === "navigate"), false);
});

Deno.test("widths: e-mail long, the others short, unless the owner chose", () => {
  assertEquals(contactWidths({}), DEFAULT_WIDTHS);
  assertEquals(contactWidths(null), DEFAULT_WIDTHS);
  assertEquals(contactWidths({ email: "short", phone: "long", map: "long", web: "wide" }), {
    ...DEFAULT_WIDTHS,
    email: "short",
    phone: "long",
  });
  // only what differs from the default is saved
  assertEquals(widthChoices({ email: "long", phone: "long", web: "short", facebook: "x" }), { phone: "long" });
});

Deno.test("two columns: a long button takes the row; a short one before it stays in the left column", () => {
  const places = gridPlaces(contactButtons(full, DEFAULT_WIDTHS, labels));
  assertEquals(places, [
    { row: 1, column: 1, span: 1 },
    { row: 1, column: 2, span: 1 },
    { row: 2, column: 1, span: 1 }, // Web, alone: e-mail is long
    { row: 3, column: 1, span: 2 },
    { row: 4, column: 1, span: 1 },
    { row: 4, column: 2, span: 1 },
  ]);
  assertEquals(gridPlaces([{ width: "long" }, { width: "short" }]), [
    { row: 1, column: 1, span: 2 },
    { row: 2, column: 1, span: 1 },
  ]);
});

Deno.test("a label that would not fit is set smaller (Screen 11: decided from the texts, never measured)", () => {
  const sk = { hold: "Držte stlačené", done: "Otvorené" };
  assertEquals(smallLabel({ label: "Facebook", ...sk }, "short"), false);
  assertEquals(smallLabel({ label: "Rezervovať termín", hold: sk.hold, done: "Rezervácie otvorené" }, "short"), true);
  assertEquals(smallLabel({ label: "obchod@potraviny-centrum.example.sk", ...sk }, "long"), false);
  assertEquals(smallLabel({ label: "obchod@potraviny-centrum.example.sk", ...sk }, "short"), true);
  assertEquals(smallLabel({ label: "nakup.informacie@velmi-dlha-domena-obchodu.example.sk", ...sk }, "long"), true);
  // "Pustite" (with its check) counts too: the three languages fit a short button, a long text would not
  for (const release of ["Pustite", "Engedje el", "Let go"]) assertEquals(smallLabel({ label: "Web", ...sk, release }, "short"), false);
  assertEquals(smallLabel({ label: "Web", ...sk, release: "Teraz prst pustite, prosím" }, "short"), true);
});
