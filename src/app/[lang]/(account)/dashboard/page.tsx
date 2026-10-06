import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { formatDateTime, formatPrice } from "@/lib/format";
import { DAYS, dayName, type DayKey, type OpeningHours } from "@/lib/hours";
import { availabilityText, type AvailabilityKey, type FreshnessState } from "@/lib/stock";
import { HoursEditor } from "@/components/HoursEditor";
import { DbError } from "@/components/DbError";
import { saveAmenities, saveShopDetails, saveVisibility, setItemPublic, uploadLogo } from "./actions";

const PAGE_SIZE = 50;

interface OwnShop {
  id: string;
  slug: string;
  name: string;
  phone: string | null;
  website: string | null;
  opening_hours: OpeningHours | null;
  visibility_mode: "exact" | "in_stock" | "yes_no";
  low_stock_threshold: number;
  logo_url: string | null;
  timezone: string;
  is_active: boolean;
  has_toilet: boolean;
  has_douchette: boolean;
  has_card_terminal: boolean;
}

interface OwnerItem {
  item_id: string;
  source_code: string;
  item_name: string;
  ean: string | null;
  price: number | null;
  currency: string;
  quantity: number | null;
  availability: AvailabilityKey | null;
  is_public: boolean;
  total_count: number;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DashboardPage({ params, searchParams }: PageProps<"/[lang]/dashboard">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase, user, isAdmin } = session;
  const sp = await searchParams;

  const { data: memberships } = await supabase.from("shop_members").select("shop_id").eq("user_id", user.id);
  const shopIds = (memberships ?? []).map((m) => m.shop_id as string);
  if (shopIds.length === 0) {
    if (isAdmin) redirect(`/${lang}/admin`);
    return <p className="border border-line p-4">{dict.dashboard.no_shop}</p>;
  }

  const { data: shopRows } = await supabase
    .from("shops")
    .select("id, slug, name, phone, website, opening_hours, visibility_mode, low_stock_threshold, logo_url, timezone, is_active, has_toilet, has_douchette, has_card_terminal")
    .in("id", shopIds)
    .order("name");
  const shops = (shopRows ?? []) as OwnShop[];
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];
  if (!shop) return <p className="border border-line p-4">{dict.dashboard.no_shop}</p>;

  const q = (first(sp.q) ?? "").trim();
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const [{ data: syncRows, error: e1 }, { data: previewRows, error: e2 }, { data: itemRows, error: e3 }] = await Promise.all([
    supabase.rpc("my_sync_status", { p_shop_id: shop.id }),
    supabase.rpc("availability_preview", { p_threshold: shop.low_stock_threshold }),
    supabase.rpc("owner_items", { p_shop_id: shop.id, q: q || null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE }),
  ]);
  const dbError = e1 ?? e2 ?? e3;
  if (dbError) return <DbError message={dbError.message} dict={dict} />;
  const sync = (syncRows ?? [])[0] as
    | { latest_file_time: string | null; last_error: string | null; freshness_state: FreshnessState }
    | undefined;
  const preview = (previewRows ?? []) as { mode: string; quantity: number; label: AvailabilityKey | null }[];
  const items = (itemRows ?? []) as OwnerItem[];
  const total = Number(items[0]?.total_count ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const ok = first(sp.ok);
  const err = first(sp.err);
  const hidden = (extra: Record<string, string> = {}) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop.id} />
      <input type="hidden" name="shop_slug" value={shop.slug} />
      {Object.entries(extra).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
  const pageUrl = (n: number) =>
    `/${lang}/dashboard?${new URLSearchParams({ shop: shop.slug, ...(q ? { q } : {}), page: String(n) })}#items`;

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        {shops.length > 1 && (
          <nav className="flex flex-wrap gap-3 text-sm" aria-label={dict.dashboard.shop}>
            {shops.map((s) => (
              <Link
                key={s.id}
                href={`/${lang}/dashboard?shop=${s.slug}`}
                className={s.id === shop.id ? "font-semibold underline underline-offset-4" : "text-muted hover:underline"}
              >
                {s.name}
              </Link>
            ))}
          </nav>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">{shop.name}</h1>
        {shop.is_active && (
          <Link href={`/${lang}/shops/${shop.slug}`} className="text-sm underline underline-offset-4">
            {dict.dashboard.view_public}
          </Link>
        )}
        {ok && <p className="border border-foreground p-3 font-medium">{dict.account.saved}</p>}
        {err && (
          <p className="border border-line p-3">
            {err === "logo" ? dict.dashboard.logo_bad : t(dict.account.error, { message: err })}
          </p>
        )}
      </header>

      <Section title={dict.dashboard.sync_title}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
          <dt className="text-muted">{dict.dashboard.latest_file}</dt>
          <dd>{sync?.latest_file_time ? formatDateTime(sync.latest_file_time, lang, shop.timezone) : dict.account.never}</dd>
          <dt className="text-muted">{dict.dashboard.state}</dt>
          <dd className="font-semibold">{stateText(dict, sync?.freshness_state ?? "stale")}</dd>
          <dt className="text-muted">{dict.dashboard.last_error}</dt>
          <dd>{sync?.last_error || dict.account.none}</dd>
        </dl>
        <Link href={`/${lang}/sync`} className="self-start font-medium underline underline-offset-4">
          {dict.dashboard.sync_link}
        </Link>
      </Section>

      <Section title={dict.dashboard.details_title}>
        <form action={saveShopDetails} className="flex flex-col gap-3">
          {hidden()}
          <Field label={dict.dashboard.phone}>
            <input name="phone" type="tel" defaultValue={shop.phone ?? ""} maxLength={40} className={inputClass} />
          </Field>
          <Field label={dict.dashboard.website}>
            <input name="website" type="url" defaultValue={shop.website ?? ""} placeholder="https://" className={inputClass} />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-sm">{dict.dashboard.hours}</span>
            <HoursEditor
              name="opening_hours"
              initial={shop.opening_hours}
              dayNames={Object.fromEntries(DAYS.map((d) => [d, dayName(d, lang)])) as Record<DayKey, string>}
              labels={{ closed: dict.dashboard.closed_day, add: dict.dashboard.add_range, remove: dict.dashboard.remove_range }}
            />
          </div>
          <SubmitButton>{dict.account.save}</SubmitButton>
        </form>
      </Section>

      <Section title={dict.dashboard.amenities_title}>
        <form action={saveAmenities} className="flex flex-col gap-2">
          {hidden()}
          <p className="text-sm text-muted">{dict.dashboard.amenities_hint}</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="has_toilet" defaultChecked={shop.has_toilet} />
            {dict.shop.toilet}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="has_douchette" defaultChecked={shop.has_douchette} />
            {dict.shop.douchette}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="has_card_terminal" defaultChecked={shop.has_card_terminal} />
            {dict.shop.card_terminal}
          </label>
          <SubmitButton>{dict.account.save}</SubmitButton>
        </form>
      </Section>

      <Section title={dict.dashboard.logo_title}>
        <form action={uploadLogo} className="flex flex-col gap-3">
          {hidden()}
          {shop.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element -- logo from Supabase Storage
            <img src={shop.logo_url} alt="" width={64} height={64} className="h-16 w-16 border border-line object-contain" />
          )}
          <input name="logo" type="file" accept="image/png,image/jpeg,image/webp" required className="text-sm" />
          <p className="text-sm text-muted">{dict.dashboard.logo_hint}</p>
          <SubmitButton>{dict.dashboard.upload}</SubmitButton>
        </form>
      </Section>

      <Section title={dict.dashboard.visibility_title}>
        <form action={saveVisibility} className="flex flex-col gap-3">
          {hidden()}
          {(["exact", "in_stock", "yes_no"] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-2">
              <input type="radio" name="visibility_mode" value={mode} defaultChecked={shop.visibility_mode === mode} />
              {dict.dashboard[`mode_${mode}`]}
            </label>
          ))}
          <Field label={dict.dashboard.threshold}>
            <input
              name="low_stock_threshold"
              type="number"
              min={1}
              max={50}
              required
              defaultValue={shop.low_stock_threshold}
              className={`${inputClass} w-24`}
            />
          </Field>
          <SubmitButton>{dict.account.save}</SubmitButton>
        </form>
        <div className="flex flex-col gap-1 pt-2">
          <span className="text-sm text-muted">{dict.dashboard.preview}</span>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="py-1 pr-2 font-normal text-muted" />
                {preview
                  .filter((p) => p.mode === "exact")
                  .map((p) => (
                    <th key={p.quantity} className="py-1 pr-2 font-normal text-muted">
                      {t(dict.dashboard.preview_qty, { n: p.quantity })}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {(["exact", "in_stock", "yes_no"] as const).map((mode) => (
                <tr key={mode} className={`border-b border-line ${shop.visibility_mode === mode ? "font-semibold" : ""}`}>
                  <th scope="row" className="py-1 pr-2 text-left font-normal">
                    {shop.visibility_mode === mode ? "→ " : ""}
                    {dict.dashboard[`mode_${mode}`]}
                  </th>
                  {preview
                    .filter((p) => p.mode === mode)
                    .map((p) => (
                      <td key={p.quantity} className="py-1 pr-2">
                        {availabilityText(dict, p.label, p.quantity)}
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={dict.dashboard.items_title} id="items">
        <p className="text-sm text-muted">{dict.dashboard.items_hint}</p>
        <form method="get" className="flex gap-2" role="search">
          <input type="hidden" name="shop" value={shop.slug} />
          <input type="search" name="q" defaultValue={q} placeholder={dict.dashboard.search} className={`${inputClass} min-w-0 flex-1`} />
          <SubmitButton>{dict.search.button}</SubmitButton>
        </form>
        {items.length === 0 ? (
          <p>{q ? dict.shop.no_items : dict.dashboard.no_items}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-1 pr-2 font-normal">{dict.dashboard.name}</th>
                  <th className="py-1 pr-2 font-normal">{dict.dashboard.code}</th>
                  <th className="py-1 pr-2 text-right font-normal">{dict.dashboard.price}</th>
                  <th className="py-1 pr-2 text-right font-normal">{dict.dashboard.quantity}</th>
                  <th className="py-1 pr-2 font-normal">{dict.dashboard.stock}</th>
                  <th className="py-1 font-normal">{dict.dashboard.public}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.item_id} className={`border-b border-line ${item.is_public ? "" : "text-muted"}`}>
                    <td className="py-2 pr-2">{item.item_name}</td>
                    <td className="py-2 pr-2 tabular-nums">{item.source_code}</td>
                    <td className="whitespace-nowrap py-2 pr-2 text-right">{formatPrice(item.price, lang, item.currency)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{item.quantity ?? ""}</td>
                    <td className="py-2 pr-2">
                      {item.is_public ? availabilityText(dict, item.availability, item.quantity) ?? "–" : dict.dashboard.hidden}
                    </td>
                    <td className="py-2">
                      <form action={setItemPublic}>
                        {hidden({ item_id: item.item_id, is_public: String(!item.is_public), q, page: String(page) })}
                        <button type="submit" className="underline underline-offset-4">
                          {item.is_public ? dict.dashboard.hide : dict.dashboard.show}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <nav className="flex items-center justify-between text-sm">
            {page > 1 ? <a href={pageUrl(page - 1)} className="underline">{dict.shop.prev}</a> : <span />}
            <span className="text-muted">{t(dict.shop.page_of, { page, pages })}</span>
            {page < pages ? <a href={pageUrl(page + 1)} className="underline">{dict.shop.next}</a> : <span />}
          </nav>
        )}
      </Section>
    </div>
  );
}

const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

function stateText(dict: Dictionary, state: FreshnessState): string {
  return dict.account[`state_${state}`];
}

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-3">
      <h2 className="border-b border-line pb-1 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{label}</span>
      {children}
    </label>
  );
}

function SubmitButton({ children }: { children: React.ReactNode }) {
  return (
    <button type="submit" className="self-start rounded border border-foreground px-4 py-2 font-medium">
      {children}
    </button>
  );
}

