import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { countText } from "../Conversations";
import { hiddenFields, inputClass, ProOnly, ShopSwitcher } from "../shared";
import { deleteTemplate, saveContact, saveTemplate } from "./actions";
import { chooseShop, ContactFields, type ContactRow, Notice, VariableList } from "./parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/contacts">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).contacts.title };
}

const PAGE_SIZE = 50;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);


interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
  updated_at: string;
}

/**
 * "Kontakty" (database update 56, CRM phase 2; Pro): the shop's contacts with search and a tag filter, "Nový kontakt",
 * and the e-mail templates (?view=templates). Reading stays possible without the plan; every change is refused in SQL.
 */
export default async function ContactsPage({ params, searchParams }: PageProps<"/[lang]/dashboard/contacts">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const c = dict.contacts;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);
  const view = first(sp.view) === "templates" ? "templates" : "contacts";
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const tag = (first(sp.tag) ?? "").trim().slice(0, 40);
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const conversation = first(sp.conversation) ?? "";

  const [plan, list, tags, templates] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    view === "contacts"
      ? supabase.rpc("owner_contacts", { p_shop_id: shop.id, p_q: q || null, p_tag: tag || null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE })
      : Promise.resolve({ data: [], error: null }),
    view === "contacts" ? supabase.rpc("owner_contact_tags", { p_shop_id: shop.id }) : Promise.resolve({ data: [], error: null }),
    view === "templates"
      ? supabase.from("shop_email_templates").select("id, name, subject, body, updated_at").eq("shop_id", shop.id).order("name")
      : Promise.resolve({ data: [], error: null }),
  ]);
  const hasPlan = !plan.error && plan.data === true;
  const unavailable = Boolean(list.error || templates.error);
  const rows = (list.data ?? []) as ContactRow[];
  const total = Number(rows[0]?.total_count ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hidden = hiddenFields(lang, shop);
  const base = { shop: shop.slug };
  const url = (query: Record<string, string>) => `/${lang}/dashboard/contacts?${new URLSearchParams({ ...base, ...query })}`;
  const planUrl = `/${lang}/dashboard/plan?${new URLSearchParams(base)}`;
  const filtered = Boolean(q || tag);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{c.title}</h1>
        <ShopSwitcher shops={chosen.shops} current={shop} label={dict.dashboard.shop} href={(slug) => `/${lang}/dashboard/contacts?shop=${slug}`} />
        <p className="text-muted">{shop.name}</p>
        <p className="text-sm">{c.intro}</p>
        {!hasPlan && <ProOnly dict={dict} href={planUrl} />}
        <Notice sp={sp} dict={dict} />
      </header>

      <nav aria-label={c.tabs} className="flex flex-wrap gap-1 border-b border-line" data-contact-tabs>
        {(["contacts", "templates"] as const).map((to) => (
          <Link
            key={to}
            href={url(to === "templates" ? { view: "templates" } : {})}
            aria-current={view === to ? "page" : undefined}
            className={`-mb-px flex min-h-11 items-center border-b-2 px-3 text-sm ${view === to ? "border-foreground font-semibold" : "border-transparent text-muted"}`}
          >
            {to === "contacts" ? c.tab_contacts : c.tab_templates}
          </Link>
        ))}
      </nav>

      {unavailable ? (
        <p className="text-sm text-muted">{c.unavailable}</p>
      ) : view === "templates" ? (
        <Templates templates={(templates.data ?? []) as Template[]} dict={dict} hidden={hidden} hasPlan={hasPlan} />
      ) : (
        <section className="flex flex-col gap-4" data-contacts>
          {hasPlan && (
            <details id="new" open={first(sp.new) === "1" || Boolean(conversation)} className="border border-line p-3" data-new-contact>
              <summary className="cursor-pointer font-semibold">{c.new}</summary>
              <form action={saveContact} className="mt-3 flex flex-col gap-3">
                {hidden(conversation ? { conversation_id: conversation } : {})}
                <ContactFields dict={dict} contact={null} />
                <PendingButton pending={dict.owner.saving}>{c.save}</PendingButton>
              </form>
            </details>
          )}

          <form method="get" action={`/${lang}/dashboard/contacts`} role="search" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="shop" value={shop.slug} />
            <label className="flex min-w-48 flex-1 flex-col gap-1">
              <span className="text-sm">{c.search}</span>
              <input type="search" name="q" defaultValue={q} maxLength={100} className={inputClass} />
            </label>
            {((tags.data ?? []) as { tag: string }[]).length > 0 && (
              <label className="flex flex-col gap-1">
                <span className="text-sm">{c.tag_filter}</span>
                <select name="tag" defaultValue={tag} className={`${inputClass} bg-white`}>
                  <option value="">{c.all_tags}</option>
                  {((tags.data ?? []) as { tag: string; contacts: number }[]).map((x) => (
                    <option key={x.tag} value={x.tag}>
                      {x.tag} ({x.contacts})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="submit" className="min-h-11 rounded border border-foreground px-4 font-medium">
              {c.filter}
            </button>
            {filtered && (
              <Link href={url({})} className="py-2 text-sm underline underline-offset-4">
                {c.reset}
              </Link>
            )}
          </form>

          {rows.length === 0 ? (
            <p className="text-sm text-muted">{filtered ? c.none_found : c.none}</p>
          ) : (
            <>
              <p className="text-sm text-muted">{countText(c as Record<string, string>, "count", total, lang)}</p>
              <ul className="flex flex-col divide-y divide-line border-y border-line" data-contact-list>
                {rows.map((row) => (
                  <li key={row.id}>
                    <Link href={`/${lang}/dashboard/contacts/${row.id}`} className="group flex flex-col gap-1 py-3" data-contact={row.id}>
                      <span className="font-semibold group-hover:underline">{row.name || row.phone || row.email || c.no_name}</span>
                      <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                        {row.phone && (
                          <span>
                            {row.phone} <span className="text-xs text-muted">· {row.phone_verified ? c.verified : c.not_verified}</span>
                          </span>
                        )}
                        {row.email && <span className="break-all">{row.email}</span>}
                      </span>
                      <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                        {row.tags.map((x) => (
                          <span key={x} className="rounded border border-line px-1.5">
                            {x}
                          </span>
                        ))}
                        {row.conversation_count > 0 && <span>{t(c.conversations_count, { n: row.conversation_count })}</span>}
                        {row.last_message_at && <span>{t(c.last_message, { date: formatDateTime(row.last_message_at, lang as Locale, shop.timezone) })}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {pages > 1 && (
                <nav className="flex items-center justify-between text-sm">
                  {page > 1 ? (
                    <a href={url({ ...(q ? { q } : {}), ...(tag ? { tag } : {}), page: String(page - 1) })} className="underline">
                      {dict.shop.prev}
                    </a>
                  ) : (
                    <span />
                  )}
                  <span className="text-muted">{t(dict.shop.page_of, { page, pages })}</span>
                  {page < pages ? (
                    <a href={url({ ...(q ? { q } : {}), ...(tag ? { tag } : {}), page: String(page + 1) })} className="underline">
                      {dict.shop.next}
                    </a>
                  ) : (
                    <span />
                  )}
                </nav>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** "E-mailové šablóny": each template editable in its own box, a new one, the variables. */
function Templates({
  templates,
  dict,
  hidden,
  hasPlan,
}: {
  templates: Template[];
  dict: Dictionary;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  hasPlan: boolean;
}) {
  const c = dict.contacts;
  const fields = (tpl: Template | null) => (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{c.template_name}</span>
        <input name="name" required maxLength={80} defaultValue={tpl?.name ?? ""} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{c.subject}</span>
        <input name="subject" required maxLength={200} defaultValue={tpl?.subject ?? ""} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{c.body}</span>
        <textarea name="body" required rows={8} maxLength={10000} defaultValue={tpl?.body ?? ""} className={inputClass} />
      </label>
    </>
  );
  return (
    <section className="flex flex-col gap-4" data-templates>
      <p className="text-sm">{c.templates_intro}</p>
      <VariableList dict={dict} />
      {templates.length === 0 && <p className="text-sm text-muted">{c.template_none}</p>}
      {templates.map((tpl) => (
        <details key={tpl.id} className="border border-line p-3" data-template={tpl.id}>
          <summary className="cursor-pointer font-semibold">{tpl.name}</summary>
          <form action={saveTemplate} className="mt-3 flex flex-col gap-3">
            {hidden({ template_id: tpl.id })}
            {fields(tpl)}
            {hasPlan && <PendingButton pending={dict.owner.saving}>{c.template_save}</PendingButton>}
          </form>
          <form action={deleteTemplate} className="mt-2">
            {hidden({ template_id: tpl.id })}
            <button type="submit" className="text-sm underline underline-offset-4">
              {c.template_delete}
            </button>
          </form>
        </details>
      ))}
      {hasPlan && (
        <details className="border border-line p-3" open={templates.length === 0} data-template-new>
          <summary className="cursor-pointer font-semibold">{c.template_new}</summary>
          <form action={saveTemplate} className="mt-3 flex flex-col gap-3">
            {hidden()}
            {fields(null)}
            <PendingButton pending={dict.owner.saving}>{c.template_save}</PendingButton>
          </form>
        </details>
      )}
    </section>
  );
}
