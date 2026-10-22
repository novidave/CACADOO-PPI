import { legalUnchecked } from "@/i18n/dictionaries";

/**
 * On a legal page (privacy, terms) in a language whose texts are machine translations nobody checked yet:
 * "Strojový preklad – záväzná je slovenská verzia" with a link to the Slovak page (update 40).
 */
export async function MachineTranslationNote({ lang, prefixes, text, slovakHref }: { lang: string; prefixes: readonly string[]; text: string; slovakHref: string }) {
  if (!(await legalUnchecked(lang, prefixes))) return null;
  return (
    <p className="border border-line p-3 text-sm" data-machine-translation>
      {text}{" "}
      <a href={slovakHref} hrefLang="sk" lang="sk" className="underline underline-offset-4">
        Slovenčina
      </a>
    </p>
  );
}
