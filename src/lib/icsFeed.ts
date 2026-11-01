/**
 * Update 63: the read-only calendar a phone subscribes to ("Odkaz pre kalendár v telefóne"): the shop's confirmed bookings
 * as iCalendar (RFC 5545). Only what calendar_feed() returns — the service, the first name, the resource, the people —
 * never a phone number, an e-mail, a note or a conversation. Shared by the route and its test.
 */
export interface FeedRow {
  shop_name: string;
  timezone: string;
  booking_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  service_name: string | null;
  resource_name: string | null;
  first_name: string | null;
  people: number | null;
  updated_at: string | null;
}

/** A TEXT value: backslash, semicolon, comma and line breaks escaped. */
export const icsText = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** "20261106T093000Z". */
export const icsTime = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Lines longer than 75 octets folded (a CRLF and one space), never inside a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let part = "";
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(part);
      part = "";
      size = 0;
    }
    part += ch;
    size += n;
  }
  out.push(part);
  return out.join("\r\n ");
}

/** The whole calendar. `now` is the stamp of rows without an update time. */
export function icsCalendar(rows: FeedRow[], fallbackName: string, now = new Date()): string {
  const name = rows[0]?.shop_name ?? fallbackName;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cacaduu//Rezervacie//SK",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`,
    ...(rows[0]?.timezone ? [`X-WR-TIMEZONE:${icsText(rows[0].timezone)}`] : []),
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ];
  for (const r of rows) {
    const summary = [r.service_name, r.first_name, r.resource_name].filter(Boolean).join(" · ") || name;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${r.booking_id}@cacaduu.com`,
      `DTSTAMP:${icsTime(r.updated_at ?? now.toISOString())}`,
      `DTSTART:${icsTime(r.starts_at)}`,
      `DTEND:${icsTime(r.ends_at)}`,
      `SUMMARY:${icsText((r.people ?? 1) > 1 ? `${summary} (${r.people})` : summary)}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
