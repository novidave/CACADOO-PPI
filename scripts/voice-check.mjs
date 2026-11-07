#!/usr/bin/env node
/**
 * How the shop assistant sounds (2026-11-07): asks a test shop's assistant 10 everyday questions and fails when an
 * answer talks about the system (`BANNED_WORDS` of src/lib/assistantVoice.ts: inventár, inventory, údaje, databáz,
 * k dispozícii, systém). Run BY HAND — it spends AI tokens and needs a site whose server has ANTHROPIC_API_KEY:
 *
 *   VOICE_BASE_URL=http://localhost:3000 VOICE_SHOP=cacadoo-paint-shop-budince node scripts/voice-check.mjs
 *
 * Optional: VOICE_LANG (sk), VOICE_QUESTIONS (a JSON array of 10 questions for another kind of shop).
 * Never run in CI. Prints each question, the answer and the banned words it found; exit code 1 when any was found.
 */
import { readFileSync } from "node:fs";

const base = (process.env.VOICE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const shop = process.env.VOICE_SHOP ?? "";
const lang = process.env.VOICE_LANG ?? "sk";
if (!/^[a-z0-9-]{1,80}$/.test(shop)) {
  console.error("Set VOICE_SHOP to the test shop's slug (e.g. VOICE_SHOP=cacadoo-paint-shop-budince).");
  process.exit(2);
}

// the same list as src/lib/assistantVoice.ts (read from the file, so the two never differ)
const source = readFileSync(new URL("../src/lib/assistantVoice.ts", import.meta.url), "utf8");
const listText = source.match(/BANNED_WORDS = \[([^\]]*)\]/)?.[1] ?? "";
const banned = [...listText.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (!banned.length) {
  console.error("BANNED_WORDS not found in src/lib/assistantVoice.ts");
  process.exit(2);
}
const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const questions = process.env.VOICE_QUESTIONS
  ? JSON.parse(process.env.VOICE_QUESTIONS)
  : [
      "Máte bielu farbu?",
      "Koľko stojí najlacnejšia farba?",
      "Máte niečo na drevo do exteriéru?",
      "Je na sklade penetrácia?",
      "Potrebujem natrieť izbu 4 × 4 m, čo budem potrebovať?",
      "Máte maliarsku pásku?",
      "Do you have white paint?",
      "Van fehér festékük?",
      "Máte valček na fasádu?",
      "Koľko kusov štetcov máte?",
    ];

let failed = 0;
for (const [i, question] of questions.entries()) {
  const res = await fetch(`${base}/api/shops/${shop}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lang, history: [], message: question }),
  });
  const body = await res.json().catch(() => ({}));
  const answer = typeof body.answer === "string" ? body.answer : "";
  const found = banned.filter((w) => fold(answer).includes(fold(w)));
  if (!res.ok || !answer) {
    console.log(`${i + 1}. ${question}\n   ✗ no answer (HTTP ${res.status}${body.error ? `, ${body.error}` : ""})`);
    failed++;
    continue;
  }
  console.log(`${i + 1}. ${question}\n   ${answer}\n   ${found.length ? `✗ banned: ${found.join(", ")}` : "✓"}`);
  if (found.length) failed++;
}
console.log(failed ? `\n${failed} of ${questions.length} answers failed.` : `\nAll ${questions.length} answers passed.`);
process.exit(failed ? 1 : 0);
