import { t, type Dictionary } from "@/i18n/dictionaries";
import { saveLanguages } from "./translationActions";
import { SubmitButton } from "./shared";

/** owner_language_settings() (database update 40). */
export interface LanguageSettings {
  main_lang: string;
  inventory_langs: string[];
  preferred_langs: string[];
  domain_lang: string | null;
  auto_descriptions: boolean;
  max_preferred: number;
  saved: boolean;
}

type Language = { code: string; native: string };

/**
 * "Jazyky": the shop's own language, the languages of its stock files, its preferred languages (pre-translated, first
 * in the picker, the files of the translations folder; the plan's number), the own domain's default language and
 * whether Claude's descriptions go live by themselves. On "Priečinok s exportom" → "Po nahratí súboru" since update 45.
 */
export function LanguagesForm({
  settings,
  all,
  dict,
  hidden,
}: {
  settings: LanguageSettings;
  all: Language[];
  dict: Dictionary;
  hidden: () => React.ReactNode;
}) {
  const o = dict.owner_tr;
  const others = all.filter((l) => l.code !== settings.main_lang);
  return (
    <form action={saveLanguages} className="flex flex-col gap-5" id="languages" data-language-settings>
      {hidden()}
      <label className="flex flex-col gap-1">
        <span className="font-semibold">{o.main_label}</span>
        <select name="main_lang" defaultValue={settings.main_lang} className="rounded border border-line px-3 py-2" data-main-lang>
          {all.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted">{o.main_help}</span>
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="font-semibold">{o.inventory_label}</legend>
        <LanguageChecks name="inventory_langs" langs={others} checked={settings.inventory_langs} />
        <span className="text-sm text-muted">{o.inventory_help}</span>
      </fieldset>

      <fieldset className="flex flex-col gap-2" data-preferred>
        <legend className="font-semibold">{o.preferred_label}</legend>
        <span className="text-sm">{t(o.preferred_limit, { n: settings.max_preferred })}</span>
        <LanguageChecks name="preferred_langs" langs={others} checked={settings.preferred_langs} />
        <span className="text-sm text-muted">{o.preferred_help}</span>
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className="font-semibold">{o.domain_label}</span>
        <select name="domain_lang" defaultValue={settings.domain_lang ?? ""} className="rounded border border-line px-3 py-2" data-domain-lang>
          <option value="">{o.domain_main}</option>
          {all.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted">{o.domain_help}</span>
      </label>

      <label className="flex items-start gap-2">
        <input type="checkbox" name="auto_descriptions" defaultChecked={settings.auto_descriptions} className="mt-1" data-auto-descriptions />
        <span className="flex flex-col gap-1">
          <span className="font-semibold">{o.auto_label}</span>
          <span className="text-sm text-muted">{o.auto_help}</span>
        </span>
      </label>

      <SubmitButton pending={dict.owner.saving}>{o.save}</SubmitButton>
    </form>
  );
}

function LanguageChecks({ name, langs, checked }: { name: string; langs: Language[]; checked: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
      {langs.map((l) => (
        <label key={l.code} className="flex items-center gap-2 text-sm">
          <input type="checkbox" name={name} value={l.code} defaultChecked={checked.includes(l.code)} data-lang-check={`${name}:${l.code}`} />
          <span lang={l.code}>{l.native}</span>
        </label>
      ))}
    </div>
  );
}
