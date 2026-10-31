// Unit tests (Deno) of the shop page's contact buttons (database update 51): order, hidden empty buttons, links,
// widths and their defaults, where the buttons land in the two columns, and directions by position or address.
// Run: npm run test:site
import { assertEquals } from "jsr:@std/assert@1";
import {
  CONTACT_COLORS,
  contactButtons,
  contactWidths,
  DEFAULT_WIDTHS,
  gridPlaces,
  navigateHref,
  smallLabel,
  widthChoices,
  type ContactShop,
} from "./contactButtons.ts";

const labels = { facebook: "Facebook", booking: "Rezervovať termín", web: "Web", navigate: "Navigovať" };
const full: ContactShop = {
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
});
