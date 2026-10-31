import type { requireUser } from "@/lib/auth";
import type { Dictionary } from "@/i18n/dictionaries";
import type { MyShop } from "@/lib/myShops";
import { TEMPLATE_VARIABLES, variableToken } from "@/lib/crm";
import { inputClass } from "../shared";

/** The parts "Kontakty" and a contact's page share (database update 56). */

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** One row of owner_contacts(). */
export interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  phone_verified: boolean;
  email: string | null;
  tags: string[];
  source: string;
  updated_at: string;
  conversation_count: number;
  message_count: number;
  last_message_at: string | null;
  total_count: number;
}

/** The shop's message after a form ("ok" / "err" are `contacts.*` keys). */
export function Notice({ sp, dict }: { sp: Record<string, string | string[] | undefined>; dict: Dictionary }) {
  const texts = dict.contacts as Record<string, string>;
  const ok = first(sp.ok);
  const err = first(sp.err);
  if (ok && texts[ok]) {
    return (
      <p role="status" className="border border-foreground p-3 font-medium">
        {texts[ok]}
      </p>
    );
  }
  if (err) return <p className="border border-line p-3">{texts[err] ?? texts.err_failed}</p>;
  return null;
}

/** The variables a template can use, with what each one becomes. */
export function VariableList({ dict }: { dict: Dictionary }) {
  const c = dict.contacts as Record<string, string>;
  return (
    <div className="text-xs">
      <p className="text-muted">{c.variables}</p>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
        {TEMPLATE_VARIABLES.map((v) => (
          <li key={v}>
            <code className="font-mono">{variableToken(v)}</code> <span className="text-muted">– {c[`var_${v}`]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The fields of a contact (new or edited); `contact` null = new. */
export function ContactFields({ dict, contact }: { dict: Dictionary; contact: Partial<ContactRow> & { address?: string | null; note?: string | null } | null }) {
  const c = dict.contacts;
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{c.name}</span>
        <input name="name" maxLength={120} defaultValue={contact?.name ?? ""} autoComplete="off" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{c.phone}</span>
        <input name="phone" type="tel" maxLength={40} defaultValue={contact?.phone ?? ""} autoComplete="off" className={inputClass} />
        <span className="text-xs text-muted">{c.phone_hint}</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{c.email}</span>
        <input name="email" type="email" maxLength={254} defaultValue={contact?.email ?? ""} autoComplete="off" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{c.address}</span>
        <input name="address" maxLength={300} defaultValue={contact?.address ?? ""} autoComplete="off" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{c.tags}</span>
        <input name="tags" maxLength={1000} defaultValue={(contact?.tags ?? []).join(", ")} autoComplete="off" className={inputClass} />
        <span className="text-xs text-muted">{c.tags_hint}</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{c.note}</span>
        <textarea name="note" rows={3} maxLength={4000} defaultValue={contact?.note ?? ""} className={inputClass} />
        <span className="text-xs text-muted">{c.note_hint}</span>
      </label>
    </>
  );
}

/** Loads the owner's shops and the chosen one (by ?shop=); null = none. */
export async function chooseShop(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], slug: string | undefined) {
  const { data, error } = await supabase.rpc("my_shops");
  if (error) return { error: error.message, shops: [] as MyShop[], shop: null };
  const shops = (data ?? []) as MyShop[];
  return { error: null, shops, shop: shops.find((s) => s.slug === slug) ?? shops[0] ?? null };
}

