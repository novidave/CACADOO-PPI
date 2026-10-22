/**
 * Every language the website can be shown in (update 40). The code is the URL prefix ("/de", "/zh-hans") and a valid
 * BCP 47 tag for Intl. Which ones are switched on, and which are pre-translated for search engines, is the admin's
 * setting in the database (site_languages()); `enabledByDefault` is only the starting value of that setting.
 * Shared by the server, the browser and the tests (no imports).
 */

export type LanguageGroup = "eu" | "europe" | "other";
/** Letters that need a font beyond the brand font (Quicksand: Latin, Latin Extended, Vietnamese). */
export type Script = "latin" | "cyrillic" | "greek" | "cjk";

export interface Language {
  code: string;
  /** The language in its own name ("Deutsch"). */
  native: string;
  english: string;
  slovak: string;
  hungarian: string;
  group: LanguageGroup;
  enabledByDefault: boolean;
  script: Script;
  /** Other words people may type into the picker's search. */
  aliases?: string[];
}

export const LANGUAGES = [
  // EU languages
  { code: "sk", native: "Slovenčina", english: "Slovak", slovak: "slovenčina", hungarian: "szlovák", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "hu", native: "Magyar", english: "Hungarian", slovak: "maďarčina", hungarian: "magyar", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "en", native: "English", english: "English", slovak: "angličtina", hungarian: "angol", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "cs", native: "Čeština", english: "Czech", slovak: "čeština", hungarian: "cseh", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "pl", native: "Polski", english: "Polish", slovak: "poľština", hungarian: "lengyel", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "de", native: "Deutsch", english: "German", slovak: "nemčina", hungarian: "német", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "uk", native: "Українська", english: "Ukrainian", slovak: "ukrajinčina", hungarian: "ukrán", group: "eu", enabledByDefault: true, script: "cyrillic" },
  { code: "ro", native: "Română", english: "Romanian", slovak: "rumunčina", hungarian: "román", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "hr", native: "Hrvatski", english: "Croatian", slovak: "chorvátčina", hungarian: "horvát", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "sl", native: "Slovenščina", english: "Slovenian", slovak: "slovinčina", hungarian: "szlovén", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "bg", native: "Български", english: "Bulgarian", slovak: "bulharčina", hungarian: "bolgár", group: "eu", enabledByDefault: true, script: "cyrillic" },
  { code: "el", native: "Ελληνικά", english: "Greek", slovak: "gréčtina", hungarian: "görög", group: "eu", enabledByDefault: true, script: "greek" },
  { code: "it", native: "Italiano", english: "Italian", slovak: "taliančina", hungarian: "olasz", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "fr", native: "Français", english: "French", slovak: "francúzština", hungarian: "francia", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "es", native: "Español", english: "Spanish", slovak: "španielčina", hungarian: "spanyol", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "pt", native: "Português", english: "Portuguese", slovak: "portugalčina", hungarian: "portugál", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "nl", native: "Nederlands", english: "Dutch", slovak: "holandčina", hungarian: "holland", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "da", native: "Dansk", english: "Danish", slovak: "dánčina", hungarian: "dán", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "sv", native: "Svenska", english: "Swedish", slovak: "švédčina", hungarian: "svéd", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "fi", native: "Suomi", english: "Finnish", slovak: "fínčina", hungarian: "finn", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "et", native: "Eesti", english: "Estonian", slovak: "estónčina", hungarian: "észt", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "lv", native: "Latviešu", english: "Latvian", slovak: "lotyština", hungarian: "lett", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "lt", native: "Lietuvių", english: "Lithuanian", slovak: "litovčina", hungarian: "litván", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "ga", native: "Gaeilge", english: "Irish", slovak: "írčina", hungarian: "ír", group: "eu", enabledByDefault: true, script: "latin" },
  { code: "mt", native: "Malti", english: "Maltese", slovak: "maltčina", hungarian: "máltai", group: "eu", enabledByDefault: true, script: "latin" },
  // other European languages (regional ones and Russian off by default)
  { code: "nb", native: "Norsk", english: "Norwegian", slovak: "nórčina", hungarian: "norvég", group: "europe", enabledByDefault: true, script: "latin", aliases: ["bokmål", "no"] },
  { code: "is", native: "Íslenska", english: "Icelandic", slovak: "islandčina", hungarian: "izlandi", group: "europe", enabledByDefault: true, script: "latin" },
  { code: "sr", native: "Srpski", english: "Serbian (Latin)", slovak: "srbčina (latinka)", hungarian: "szerb (latin)", group: "europe", enabledByDefault: true, script: "latin" },
  { code: "sr-cyrl", native: "Српски", english: "Serbian (Cyrillic)", slovak: "srbčina (cyrilika)", hungarian: "szerb (cirill)", group: "europe", enabledByDefault: true, script: "cyrillic" },
  { code: "bs", native: "Bosanski", english: "Bosnian", slovak: "bosniačtina", hungarian: "bosnyák", group: "europe", enabledByDefault: true, script: "latin" },
  { code: "sq", native: "Shqip", english: "Albanian", slovak: "albánčina", hungarian: "albán", group: "europe", enabledByDefault: true, script: "latin" },
  { code: "mk", native: "Македонски", english: "Macedonian", slovak: "macedónčina", hungarian: "macedón", group: "europe", enabledByDefault: true, script: "cyrillic" },
  { code: "tr", native: "Türkçe", english: "Turkish", slovak: "turečtina", hungarian: "török", group: "europe", enabledByDefault: true, script: "latin" },
  { code: "ru", native: "Русский", english: "Russian", slovak: "ruština", hungarian: "orosz", group: "europe", enabledByDefault: false, script: "cyrillic" },
  { code: "ca", native: "Català", english: "Catalan", slovak: "katalánčina", hungarian: "katalán", group: "europe", enabledByDefault: false, script: "latin" },
  { code: "eu", native: "Euskara", english: "Basque", slovak: "baskičtina", hungarian: "baszk", group: "europe", enabledByDefault: false, script: "latin" },
  { code: "gl", native: "Galego", english: "Galician", slovak: "galícijčina", hungarian: "galiciai", group: "europe", enabledByDefault: false, script: "latin" },
  { code: "cy", native: "Cymraeg", english: "Welsh", slovak: "waleština", hungarian: "walesi", group: "europe", enabledByDefault: false, script: "latin" },
  { code: "lb", native: "Lëtzebuergesch", english: "Luxembourgish", slovak: "luxemburčina", hungarian: "luxemburgi", group: "europe", enabledByDefault: false, script: "latin" },
  // further languages (many shop owners in Slovakia write in Chinese or Vietnamese)
  { code: "zh-hans", native: "中文（简体）", english: "Chinese (Simplified)", slovak: "čínština (zjednodušená)", hungarian: "kínai (egyszerűsített)", group: "other", enabledByDefault: true, script: "cjk", aliases: ["chinese", "čínština", "cinstina", "kínai", "kinai", "中文", "汉语", "zh"] },
  { code: "zh-hant", native: "中文（繁體）", english: "Chinese (Traditional)", slovak: "čínština (tradičná)", hungarian: "kínai (hagyományos)", group: "other", enabledByDefault: false, script: "cjk", aliases: ["chinese", "čínština", "cinstina", "kínai", "kinai", "中文", "漢語"] },
  { code: "vi", native: "Tiếng Việt", english: "Vietnamese", slovak: "vietnamčina", hungarian: "vietnámi", group: "other", enabledByDefault: true, script: "latin", aliases: ["vietnamese", "vietnamcina", "vietnami"] },
] as const satisfies readonly Language[];

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

const BY_CODE = new Map<string, Language>(LANGUAGES.map((l) => [l.code, l]));

export function languageOf(code: string): Language | undefined {
  return BY_CODE.get(code);
}

/** The picker's "Odporúčané" on PPI's own pages (a shop's page shows the shop's preferred languages instead). */
export const MAIN_RECOMMENDED: LanguageCode[] = ["sk", "hu", "en", "cs", "uk", "pl", "de"];

/** The languages whose interface texts are written by hand in the repository (src/i18n/messages). */
export const HANDWRITTEN = ["sk", "hu", "en"] as const;

/** Lower case, without accents: "Čeština" → "cestina" (the picker's search). */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Whether a language matches what was typed in the picker's search: its own name, its English, Slovak or Hungarian name, its code or an alias. */
export function languageMatches(lang: Language, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  return [lang.native, lang.english, lang.slovak, lang.hungarian, lang.code, ...(lang.aliases ?? [])].some((w) => fold(w).includes(q));
}

/**
 * The visitor's browser languages ("de-AT,de;q=0.9,en;q=0.8") → the first one the website has switched on.
 * zh-CN/zh-SG/zh → zh-hans, zh-TW/zh-HK/zh-MO → zh-hant, no/nn → nb, sr-Cyrl → sr-cyrl.
 */
export function fromAcceptLanguage(header: string, enabled: readonly string[]): string | null {
  const parts = header
    .split(",")
    .map((p) => {
      const [tag, ...params] = p.trim().split(";");
      const q = Number(params.find((x) => x.trim().startsWith("q="))?.trim().slice(2) ?? "1");
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((p) => p.tag && p.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of parts) {
    const [base, ...rest] = tag.split("-");
    let code: string = base;
    if (base === "zh") code = rest.some((r) => ["tw", "hk", "mo", "hant"].includes(r)) ? "zh-hant" : "zh-hans";
    else if (base === "no" || base === "nn") code = "nb";
    else if (base === "sr" && rest.includes("cyrl")) code = "sr-cyrl";
    if (enabled.includes(code)) return code;
  }
  return null;
}

/**
 * The same page in another language (the picker's links): PPI's "/{lang}/…"; on a shop's own domain "/" is its home
 * language, "/{lang}" the others, items always "/{lang}/items/…" (the browser shows the domain's addresses; the page
 * itself may be "/site/{lang}/{slug}/…").
 */
export function pickerPath(pathname: string, code: string, current: string, site: { homeLang: string } | null): string {
  const parts = pathname.split("/").filter(Boolean);
  if (!site) {
    const rest = parts.slice(1).join("/");
    return `/${code}${rest ? `/${rest}` : ""}`;
  }
  const rest = parts[0] === "site" ? parts.slice(3) : parts[0] === current || languageOf(parts[0] ?? "") ? parts.slice(1) : parts;
  const tail = rest.join("/");
  if (rest[0] === "items") return `/${code}/${tail}`;
  return code === site.homeLang ? `/${tail}` : `/${code}${tail ? `/${tail}` : ""}`;
}
