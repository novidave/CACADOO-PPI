// Update 63: the shop assistant's booking tools (npm run test:booking).
import { assertEquals } from "jsr:@std/assert@1";
import { localMidnight, SERVICE_TOOLS, serviceIndex, slotWindow, toolDays, toolPeople, wantsContact } from "./bookingTools.ts";

Deno.test("no booking tool takes personal data: no name, phone, e-mail, address or code", () => {
  const banned = /name|phone|mobile|tel|mail|address|code|contact|consent/i;
  assertEquals(SERVICE_TOOLS.map((t) => t.name), ["list_services", "find_free_slots", "book_slot"]);
  for (const tool of SERVICE_TOOLS) {
    const schema = tool.input_schema as { properties: Record<string, unknown>; additionalProperties: boolean };
    assertEquals(schema.additionalProperties, false, tool.name);
    assertEquals(tool.strict, true, tool.name);
    for (const key of Object.keys(schema.properties)) assertEquals(banned.test(key), false, `${tool.name}.${key}`);
  }
});

Deno.test("service refs choose only from the list given", () => {
  assertEquals(serviceIndex("v1", 3), 0);
  assertEquals(serviceIndex("v3", 3), 2);
  assertEquals(serviceIndex("v4", 3), null);
  assertEquals(serviceIndex("v0", 3), null);
  assertEquals(serviceIndex("s1", 3), null);
  assertEquals(serviceIndex("v1; drop", 3), null);
  assertEquals(serviceIndex(undefined, 3), null);
});

Deno.test("days 1–7 and people 1–500", () => {
  assertEquals([toolDays(0), toolDays(3), toolDays(30), toolDays("x"), toolDays(2.9)], [1, 3, 7, 1, 2]);
  assertEquals([toolPeople(-2), toolPeople(4), toolPeople(9999), toolPeople(null)], [1, 4, 500, 1]);
});

Deno.test("the shop's local midnight, also on the days the clocks change", () => {
  assertEquals(localMidnight("2026-07-15", "Europe/Bratislava").toISOString(), "2026-07-14T22:00:00.000Z");
  assertEquals(localMidnight("2026-01-15", "Europe/Bratislava").toISOString(), "2026-01-14T23:00:00.000Z");
  // clocks go forward on 29 March 2026 at 02:00 (midnight is still winter time) and back on 25 October 2026
  assertEquals(localMidnight("2026-03-29", "Europe/Bratislava").toISOString(), "2026-03-28T23:00:00.000Z");
  assertEquals(localMidnight("2026-03-30", "Europe/Bratislava").toISOString(), "2026-03-29T22:00:00.000Z");
  assertEquals(localMidnight("2026-10-25", "Europe/Bratislava").toISOString(), "2026-10-24T22:00:00.000Z");
  assertEquals(localMidnight("2026-10-26", "Europe/Bratislava").toISOString(), "2026-10-25T23:00:00.000Z");
  assertEquals(localMidnight("2026-07-15", "Europe/Lisbon").toISOString(), "2026-07-14T23:00:00.000Z");
  assertEquals(localMidnight("2026-07-15", "Europe/Helsinki").toISOString(), "2026-07-14T21:00:00.000Z");
});

Deno.test("the window starts today in the shop's zone when no day is given", () => {
  // 23:30 UTC on 31 October = already 1 November in Bratislava
  const w = slotWindow("", 2, "Europe/Bratislava", new Date("2026-10-31T23:30:00Z"));
  assertEquals(w.day, "2026-11-01");
  assertEquals(w.from.toISOString(), "2026-10-31T23:00:00.000Z");
  assertEquals(w.to.toISOString(), "2026-11-03T00:00:00.000Z");
  assertEquals(slotWindow("garbage", 1, "Europe/Bratislava", new Date("2026-06-01T10:00:00Z")).day, "2026-06-01");
});

Deno.test("the contact form shows only while nothing was booked and the booking tools asked for it", () => {
  assertEquals(wantsContact(false, true, true, false), true);
  assertEquals(wantsContact(false, true, false, true), true);
  assertEquals(wantsContact(false, true, false, false), false);
  assertEquals(wantsContact(true, true, true, true), false);
  assertEquals(wantsContact(false, false, true, true), false);
});
