// Unit tests of the "Kontakty" helpers (update 56). Run: npm run test:crm
import { contactError, messageError, smsParts, splitTags, variableToken } from "./crm.ts";

function eq(actual: unknown, expected: unknown, what: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("SMS parts: GSM 160 / 153, Unicode 70 / 67, extension characters twice", () => {
  eq(smsParts(""), { chars: 0, parts: 0, unicode: false }, "empty");
  eq(smsParts("a".repeat(160)).parts, 1, "160 GSM");
  eq(smsParts("a".repeat(161)).parts, 2, "161 GSM");
  eq(smsParts("a".repeat(306)).parts, 2, "2 × 153");
  eq(smsParts("€".repeat(80)).parts, 1, "€ counts twice: 160");
  eq(smsParts("€".repeat(81)).parts, 2, "162 units");
  eq(smsParts("Dobrý deň").unicode, true, "Slovak accents are Unicode");
  eq(smsParts("ő".repeat(70)).parts, 1, "70 Unicode");
  eq(smsParts("ő".repeat(71)).parts, 2, "71 Unicode");
  eq(smsParts("Ahoj, zajtra o 10:00?").unicode, false, "plain text");
});

Deno.test("tags from one field", () => {
  eq(splitTags(" VIP, vip ; Stály zákazník\n,, "), ["VIP", "Stály zákazník"], "trimmed, once");
  eq(splitTags(Array.from({ length: 25 }, (_, i) => `t${i}`).join(",")).length, 20, "at most 20");
  eq(splitTags("x".repeat(50))[0].length, 40, "40 characters");
});

Deno.test("refusals as texts", () => {
  eq(contactError("phone_taken"), "err_phone_taken", "known");
  eq(contactError("boom"), "err_failed", "unknown");
  eq(messageError("too_many"), "err_too_many", "message");
  eq(messageError(undefined), "err_send_failed", "unknown message");
  eq(variableToken("first_name"), "{{first_name}}", "token");
});
