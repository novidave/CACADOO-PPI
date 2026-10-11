/**
 * The pasted domain name, cleaned the same way as the domains Edge Function does it (its
 * Deno tests check that both give the same answers): "https://www.Davide.sk/" → "davide.sk".
 * The function decides; this only lets the page show the cleaned name and the problem at once.
 */

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function cleanDomain(input: string): string {
  let name = String(input ?? "").trim().toLowerCase();
  name = name.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  name = name.replace(/^[^/@]*@/, "");
  name = name.split(/[/?#\\]/)[0];
  name = name.replace(/:\d*$/, "");
  name = name.replace(/\s+/g, "");
  name = name.replace(/\.+$/, "");
  while (name.startsWith("www.")) name = name.slice(4);
  return name;
}

export type NameProblem = "empty" | "no_tld" | "format" | "accents";

export function nameProblem(name: string): NameProblem | null {
  if (!name) return "empty";
  if (/[^\x00-\x7f]/.test(name)) return "accents";
  const labels = name.split(".");
  if (labels.length < 2) return "no_tld";
  if (name.length > 253 || !labels.every((l) => LABEL.test(l))) return "format";
  if (/^[0-9-]+$/.test(labels[labels.length - 1])) return "format";
  return null;
}

/** The TLD of the price table a name ends with (longest first), only one label before it. */
export function soldTld(name: string, tlds: string[]): string | null {
  const sorted = [...tlds].sort((a, b) => b.length - a.length);
  for (const tld of sorted) {
    if (!name.endsWith(`.${tld}`)) continue;
    const rest = name.slice(0, -tld.length - 1);
    return rest && !rest.includes(".") ? tld : null;
  }
  return null;
}
