/**
 * The owner's exports of "Konverzácie" (database update 55): one conversation as plain text (TXT) and a date range as
 * CSV for Excel. Pure functions (shared with conversationExport_test.ts, `npm run test:conversations`): the routes load
 * the rows with the owner's login (RLS and the owner_* functions decide what they may read) and only format them here.
 * Times are written in the shop's time zone; the shopper's text is never changed, only made safe for a spreadsheet.
 */

/** "2026-10-30 14:05" in the shop's time zone. */
export function localStamp(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * One CSV cell (separator ";", as Excel expects in Slovak and Hungarian settings): quoted when needed, and a text that
 * a spreadsheet would run as a formula (= + - @, tab, carriage return at the start) gets a leading apostrophe.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The whole CSV: a BOM (Excel then reads UTF-8), the header row, one row per line, CRLF line ends. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return "﻿" + [header, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n") + "\r\n";
}

/** One row of owner_conversations_export(). */
export interface ExportRow {
  conversation_id: string;
  started_at: string;
  status: string;
  starred: boolean;
  unanswered: boolean | null;
  access_key_used: boolean | null;
  language: string | null;
  message_at: string;
  role: "shopper" | "assistant";
  body: string;
  body_owner: string | null;
  attachments: number;
  products: string | null;
}

export interface CsvLabels {
  header: string[];
  yes: string;
  no: string;
  shopper: string;
  assistant: string;
  status: Record<string, string>;
}

/** The rows of the CSV in the order of `labels.header` (13 columns). */
export function exportCsv(rows: ExportRow[], timeZone: string, labels: CsvLabels): string {
  const flag = (v: boolean | null) => (v === null ? "" : v ? labels.yes : labels.no);
  return toCsv(
    labels.header,
    rows.map((r) => [
      r.conversation_id,
      localStamp(r.started_at, timeZone),
      labels.status[r.status] ?? r.status,
      flag(r.starred),
      flag(r.unanswered),
      flag(r.access_key_used),
      r.language ?? "",
      localStamp(r.message_at, timeZone),
      r.role === "shopper" ? labels.shopper : labels.assistant,
      r.body,
      r.body_owner ?? "",
      r.attachments || "",
      r.products ?? "",
    ]),
  );
}

export interface TxtMessage {
  role: "shopper" | "assistant";
  body: string;
  body_owner: string | null;
  created_at: string;
  unanswered?: boolean;
  files: string[];
  cards: { name?: string; price?: string; availability?: string; quantity?: number; note?: string }[];
}

export interface TxtLabels {
  title: string;
  /** [label, value] lines under the title (start, end, language, status, flags, note). */
  facts: [string, string][];
  shopper: string;
  assistant: string;
  inOwnerLang: string;
  files: string;
  unanswered: string;
}

/** One conversation as plain text: title, the facts, then every message with its time, files and product cards. */
export function conversationTxt(messages: TxtMessage[], timeZone: string, labels: TxtLabels): string {
  const lines = [labels.title, "=".repeat(Math.min(labels.title.length, 72))];
  for (const [label, value] of labels.facts) if (value) lines.push(`${label}: ${value}`);
  for (const m of messages) {
    lines.push("", `[${localStamp(m.created_at, timeZone)}] ${m.role === "shopper" ? labels.shopper : labels.assistant}:`);
    if (m.body) lines.push(m.body);
    if (m.body_owner) lines.push(`${labels.inOwnerLang} ${m.body_owner}`);
    if (m.files.length) lines.push(`${labels.files}: ${m.files.join(", ")}`);
    if (m.unanswered) lines.push(`(${labels.unanswered})`);
    for (const card of m.cards) {
      const parts = [card.quantity ? `${card.quantity}× ${card.name ?? ""}` : (card.name ?? ""), card.price, card.availability].filter(Boolean);
      lines.push(`  • ${parts.join(" – ")}${card.note ? ` (${card.note})` : ""}`);
    }
  }
  return lines.join("\r\n") + "\r\n";
}

/** "konverzacia_2026-10-30_14-05_3f2a9c1b.txt" (the same pattern as the PDFs' names). */
export function exportName(startedAt: string, id: string, timeZone: string, ext: "txt" | "csv"): string {
  return `konverzacia_${localStamp(startedAt, timeZone).replace(" ", "_").replace(":", "-")}_${id.slice(0, 8)}.${ext}`;
}
