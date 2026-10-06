import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { formatDateTime, formatPrice } from "@/lib/format";
import { guessShopRegion } from "@/lib/location";
import { MAPPING_FIELDS, REQUIRED_FIELDS, type MyShop } from "@/lib/myShops";
import { availabilityText, type AvailabilityKey } from "@/lib/stock";
import { folderSyncLabels } from "@/lib/syncLabels";
import { DbError } from "@/components/DbError";
import { FolderSync } from "@/components/FolderSync";
import { ShopForm } from "@/components/ShopForm";
import { approveColumns, deleteShop, saveShop, saveVisibility, setItemPublic, uploadLogo } from "./actions";

const PAGE_SIZE = 50;

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

const ERRORS = ["name", "limit", "columns", "website", "logo"] as const;

function errorText(dict: Dictionary, err: string): string {
  if (err === "logo") return dict.dashboard.logo_bad;
  const key = ERRORS.find((e) => e === err);
  if (key && key !== "logo") return key === "website" ? t(dict.account.error, { message: err }) : dict.owner[`error_${key}`];
  return t(dict.account.error, { message: err });
}

/**
 * The shop owner's own area (self-service): create shops, edit details, connect the
 * export folder, approve the stock-file columns, choose what shoppers see, hide items.
 */
export default async function DashboardPage({ params, searchParams }: PageProps<"/[lang]/dashboard">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const sp = await searchParams;
  const ok = first(sp.ok);
  const err = first(sp.err);
  const o = dict.owner;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];

  // No shop yet (or "+ Add another shop"): the create form.
  if (shops.length === 0 || first(sp.new) === "1") {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          {shops.length > 0 && (
            <Link href={`/${lang}/dashboard`} className="text-sm underline underline-offset-4">
              ← {dict.account.dashboard}
            </Link>
          )}
          <h1 className="text-2xl font-semibold tracking-tight">{o.create_title}</h1>
          <p className="text-muted">{o.create_intro}</p>
          {ok === "deleted" && <p className="border border-foreground p-3 font-medium">{o.deleted}</p>}
          {err && <p className="border border-line p-3">{errorText(dict, err)}</p>}
        </header>
        <ShopForm
          dict={dict}
          lang={lang}
          shop={null}
          defaults={guessShopRegion(await headers())}
          action={saveShop}
          submitLabel={o.create_button}
        />
      </div>
    );
  }

  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];
  const q = (first(sp.q) ?? "").trim();
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const [{ data: previewRows, error: e2 }, { data: itemRows, error: e3 }] = await Promise.all([
    supabase.rpc("availability_preview", { p_threshold: shop.low_stock_threshold }),
    supabase.rpc("owner_items", { p_shop_id: shop.id, q: q || null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE }),
  ]);
  const dbError = e2 ?? e3;
  if (dbError) return <DbError message={dbError.message} dict={dict} />;
  const preview = (previewRows ?? []) as { mode: string; quantity: number; label: AvailabilityKey | null }[];
  const items = (itemRows ?? []) as OwnerItem[];
  const total = Number(items[0]?.total_count ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
  const when = (iso: string | null) => (iso ? formatDateTime(iso, lang, shop.timezone) : dict.account.never);
  const okText = ok === "columns" ? o.columns_saved : dict.account.saved;

  // Columns of the stock file, from the sample rows of the last file received.
  const columns = [...new Set((shop.sample_rows ?? []).flatMap((row) => Object.keys(row)))];

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <nav className="flex flex-wrap gap-3 text-sm" aria-label={dict.dashboard.shop}>
          {shops.length > 1 &&
            shops.map((s) => (
              <Link
                key={s.id}
                href={`/${lang}/dashboard?shop=${s.slug}`}
                className={s.id === shop.id ? "font-semibold underline underline-offset-4" : "text-muted hover:underline"}
              >
                {s.name}
              </Link>
            ))}
          <Link href={`/${lang}/dashboard?new=1`} className="text-muted hover:underline">
            {o.add_shop}
          </Link>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight">{shop.name}</h1>
        {shop.is_active && (
          <Link href={`/${lang}/shops/${shop.slug}`} className="text-sm underline underline-offset-4">
            {dict.dashboard.view_public}
          </Link>
        )}
        {ok === "created" ? (
          <div className="flex flex-col gap-2 border border-foreground p-3">
            <p className="font-semibold">{o.created}</p>
            <ol className="list-decimal pl-6 text-sm">
              <li>{o.step_folder}</li>
              <li>{o.step_columns}</li>
              <li>{o.step_visible}</li>
            </ol>
          </div>
        ) : (
          ok && <p className="border border-foreground p-3 font-medium">{okText}</p>
        )}
        {err && <p className="border border-line p-3">{errorText(dict, err)}</p>}
      </header>

      <Section title={o.export_title} id="export">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted">{dict.dashboard.latest_file}</dt>
          <dd>{when(shop.latest_file_time)}</dd>
          <dt className="text-muted">{dict.dashboard.state}</dt>
          <dd className="font-semibold">{dict.account[`state_${shop.freshness_state}`]}</dd>
          <dt className="text-muted">{o.folder_seen}</dt>
          <dd>{when(shop.folder_seen_at)}</dd>
          <dt className="text-muted">{o.last_file_name}</dt>
          <dd>{shop.last_file_name || "–"}</dd>
          <dt className="text-muted">{dict.dashboard.last_error}</dt>
          <dd>{shop.last_error || dict.account.none}</dd>
        </dl>
        <FolderSync
          shopId={shop.id}
          shopName={shop.name}
          showName={false}
          lang={lang}
          timeZone={shop.timezone}
          loginHref={`/${lang}/login`}
          labels={folderSyncLabels(dict)}
        />
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{o.export_rules_title}</span>
          <ul className="list-disc pl-6">
            <li>{o.rule_folder}</li>
            <li>{o.rule_format}</li>
            <li>{o.rule_columns}</li>
            <li>{o.rule_all}</li>
            <li>{o.rule_schedule}</li>
            <li>{o.rule_public}</li>
            <li>{o.rule_pc}</li>
          </ul>
        </div>
        <Link href={`/${lang}/sync`} className="self-start text-sm underline underline-offset-4">
          {o.open_sync}
        </Link>
      </Section>

      <Section title={o.columns_title} id="columns">
        <p className="text-sm">{o.columns_intro}</p>
        {columns.length === 0 ? (
          <p className="text-muted">{o.columns_waiting}</p>
        ) : (
          <form action={approveColumns} className="flex flex-col gap-3">
            {hidden()}
            <p className="font-semibold">{shop.mapping_status === "confirmed" ? o.state_confirmed : o.state_proposed}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {MAPPING_FIELDS.map((field) => (
                <label key={field} className="flex flex-col gap-1">
                  <span className="text-sm">
                    {o[`col_${field}`]}
                    {REQUIRED_FIELDS.includes(field) && <span className="text-muted"> · {o.required}</span>}
                  </span>
                  <select
                    name={`col_${field}`}
                    required={REQUIRED_FIELDS.includes(field)}
                    defaultValue={shop.field_mapping?.[field] ?? ""}
                    className={`${inputClass} bg-white`}
                  >
                    <option value="">{o.not_in_file}</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <SampleRows rows={(shop.sample_rows ?? []).slice(0, 5)} columns={columns} title={o.sample_rows} />
            <SubmitButton>{o.approve}</SubmitButton>
          </form>
        )}
      </Section>

      <Section title={dict.dashboard.details_title} id="details">
        <ShopForm
          dict={dict}
          lang={lang}
          shop={shop}
          defaults={{ country: "", timezone: "" }}
          action={saveShop}
          submitLabel={dict.account.save}
        />
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

      <Section title={o.delete_title} id="delete">
        <form action={deleteShop} className="flex flex-col gap-3">
          {hidden()}
          <p className="text-sm">{o.delete_intro}</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="confirm" required />
            {o.delete_confirm}
          </label>
          <SubmitButton>{o.delete_button}</SubmitButton>
        </form>
      </Section>
    </div>
  );
}

const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

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


function SampleRows({ rows, columns, title }: { rows: Record<string, unknown>[]; columns: string[]; title: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted">{title}</span>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left">
              {columns.map((c) => (
                <th key={c} className="py-1 pr-3 font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-line">
                {columns.map((c) => (
                  <td key={c} className="whitespace-nowrap py-1 pr-3">
                    {String(row[c] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
