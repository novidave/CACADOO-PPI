// Every visible text comes from src/i18n/messages (update 40: it is translated into every language): this test
// fails on a new text written straight into a page or component (JSX text, placeholder, aria-label, title, alt).
// Run: npm run test:strings
const ROOT = new URL("../", import.meta.url).pathname;

/** Texts that may stay: the last-resort error screen (it cannot load the dictionaries, so it is in sk · hu · en). */
const ALLOWED: { file: string; text: RegExp }[] = [
  { file: "app/[lang]/(account)/error.tsx", text: /Stránku sa nepodarilo načítať|Skúsiť znova|^Ref:/ },
];

/** A piece of JSX text that is a word (not code, a type, a URL or a symbol). */
export function isWords(text: string): boolean {
  const t = text.trim();
  if (!/\p{L}{2,}/u.test(t)) return false;
  // TypeScript generics and code between > and <: Promise<…>, Record<…>, (a: b) => …
  if (/[()=;:[\]|&{}]|=>/.test(t)) return false;
  // a type or component name, a URL, an e-mail, a DNS record type (TXT, CNAME), a key
  if (/^[A-Z][A-Za-z]*$/.test(t) || /^[A-Z]{2,6}(\s*[^\p{L}\s])*$/u.test(t) || /^https?:\/\//.test(t) || /^[\w.+-]+@[\w.-]+$/.test(t)) return false;
  // a file name (llms.txt), or code ("new Promise")
  if (/^[\w.-]+\.(txt|xml|json|csv|pdf|html)$/.test(t) || /^new [A-Z]/.test(t)) return false;
  return true;
}

export function findTexts(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  source.split("\n").forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("import ")) return;
    for (const m of line.matchAll(/>([^<>{}\n]+)</g)) if (isWords(m[1])) out.push({ line: i + 1, text: m[1].trim() });
    // a JSX text alone on its line (between an opening and a closing tag on other lines)
    if (/^[\p{L}][^<>{}=;()]*$/u.test(s) && !/^(return|const|let|export|case|default|if|else|type|interface)\b/.test(s) && isWords(s)) {
      const prev = source.split("\n")[i - 1]?.trim() ?? "";
      if (prev.endsWith(">") && !prev.endsWith("=>")) out.push({ line: i + 1, text: s });
    }
    for (const m of line.matchAll(/\b(placeholder|aria-label|title|alt|label)="([^"]+)"/g)) {
      if (isWords(m[2]) && !/^https?:\/\//.test(m[2]) && !/[={}]/.test(m[2])) out.push({ line: i + 1, text: `${m[1]}="${m[2]}"` });
    }
  });
  return out;
}

async function* tsxFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory) yield* tsxFiles(`${path}/`);
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith("_test.tsx")) yield path;
  }
}

Deno.test("the check tells words from code", () => {
  const found = findTexts(`
    const a = async (): Promise<Record<string, string>> => x;
    <button>Uložiť</button>
    <span>{dict.shop.save}</span>
    <input placeholder="https://" />
    <input placeholder="Hľadať" />
    <p>TXT</p>
  `);
  const texts = found.map((f) => f.text);
  if (texts.join("|") !== 'Uložiť|placeholder="Hľadať"') throw new Error(`found ${JSON.stringify(texts)}`);
});

Deno.test("no visible text is written straight into a page or component", async () => {
  const problems: string[] = [];
  for await (const file of tsxFiles(ROOT)) {
    const rel = file.slice(ROOT.length);
    for (const hit of findTexts(await Deno.readTextFile(file))) {
      if (ALLOWED.some((a) => a.file === rel && a.text.test(hit.text))) continue;
      problems.push(`src/${rel}:${hit.line}: ${hit.text}`);
    }
  }
  if (problems.length) {
    throw new Error(`Move these texts into src/i18n/messages/{sk,hu,en}.json:\n${problems.join("\n")}`);
  }
});
