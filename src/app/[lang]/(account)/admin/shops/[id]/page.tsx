import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import type { AdminShop } from "@/lib/admin";
import { requireAdmin } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { DAYS, dayName, type DayKey } from "@/lib/hours";
import { HoursEditor } from "@/components/HoursEditor";
import { LocationPicker } from "@/components/LocationPicker";
import { inviteOwner, removeOwner, saveShop, saveSyncSource } from "../../actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

/** European IANA zones (plus UTC), for the time zone list. */
function timeZones(): string[] {
  try {
    return ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z.startsWith("Europe/"))];
  } catch {
    return ["UTC", "Europe/Bratislava", "Europe/Budapest", "Europe/Prague", "Europe/Vienna", "Europe/Warsaw", "Europe/Berlin"];
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminShopPage({ params, searchParams }: PageProps<"/[lang]/admin/shops/[id]">) {
  const { lang, id } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, { supabase }] = await Promise.all([getDictionary(lang), requireAdmin(lang)]);
  const isNew = id === "new";
  if (!isNew && !UUID.test(id)) notFound();

  let shop: AdminShop | null = null;
  let owners: { user_id: string; email: string }[] = [];
  if (!isNew) {
    const [{ data: shops, error }, { data: ownerRows }] = await Promise.all([
      supabase.rpc("admin_shops").eq("id", id),
      supabase.rpc("admin_shop_owners", { p_shop_id: id }),
    ]);
    if (error) throw new Error(error.message);
    shop = ((shops ?? []) as AdminShop[])[0] ?? null;
    if (!shop) notFound();
    owners = (ownerRows ?? []) as { user_id: string; email: string }[];
  }

  const sp = await searchParams;
  const ok = first(sp.ok);
  const err = first(sp.err);
  const email = first(sp.email) ?? "";
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop?.id ?? ""} />
    </>
  );

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <Link href={`/${lang}/admin`} className="text-sm underline underline-offset-4">
          {dict.admin.back}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{shop?.name ?? dict.admin.new_title}</h1>
        {shop?.is_active && (
          <Link href={`/${lang}/shops/${shop.slug}`} className="text-sm underline underline-offset-4">
            {dict.dashboard.view_public}
          </Link>
        )}
        {ok && <p className="border border-foreground p-3 font-medium">{okText(dict, ok, email)}</p>}
        {err && <p className="border border-line p-3">{errText(dict, err)}</p>}
      </header>

      <Section title={dict.admin.details}>
        <form action={saveShop} className="flex flex-col gap-3">
          {hidden}
          <Field label={dict.admin.name}>
            <input name="name" required defaultValue={shop?.name ?? ""} className={inputClass} />
          </Field>
          <Field label={dict.admin.slug} hint={dict.admin.slug_hint}>
            <input
              name="slug"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              defaultValue={shop?.slug ?? ""}
              className={inputClass}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={dict.admin.address}>
              <input name="address" defaultValue={shop?.address ?? ""} className={inputClass} />
            </Field>
            <Field label={dict.admin.city}>
              <input name="city" defaultValue={shop?.city ?? ""} className={inputClass} />
            </Field>
            <Field label={dict.admin.country}>
              <input
                name="country"
                maxLength={2}
                pattern="[A-Za-z]{2}"
                defaultValue={shop?.country ?? ""}
                className={`${inputClass} w-24 uppercase`}
              />
            </Field>
            <Field label={dict.admin.timezone}>
              <select name="timezone" defaultValue={shop?.timezone ?? "Europe/Bratislava"} className={`${inputClass} bg-white`}>
                {timeZones().map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={dict.admin.ico}>
              <input name="ico" defaultValue={shop?.ico ?? ""} className={inputClass} />
            </Field>
            <Field label={dict.dashboard.phone}>
              <input name="phone" type="tel" defaultValue={shop?.phone ?? ""} className={inputClass} />
            </Field>
          </div>
          <Field label={dict.dashboard.website}>
            <input name="website" type="url" placeholder="https://" defaultValue={shop?.website ?? ""} className={inputClass} />
          </Field>

          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm">{dict.admin.location}</legend>
            <LocationPicker
              initial={{ lat: shop?.lat ?? null, lng: shop?.lng ?? null }}
              labels={{ lat: dict.admin.lat, lng: dict.admin.lng, hint: dict.admin.map_hint, map: dict.admin.location }}
            />
          </fieldset>

          <div className="flex flex-col gap-1">
            <span className="text-sm">{dict.dashboard.hours}</span>
            <HoursEditor
              name="opening_hours"
              initial={shop?.opening_hours ?? null}
              dayNames={Object.fromEntries(DAYS.map((d) => [d, dayName(d, lang)])) as Record<DayKey, string>}
              labels={{ closed: dict.dashboard.closed_day, add: dict.dashboard.add_range, remove: dict.dashboard.remove_range }}
            />
          </div>

          <div className="flex flex-wrap gap-6">
            <Field label={dict.dashboard.visibility_title}>
              <select name="visibility_mode" defaultValue={shop?.visibility_mode ?? "in_stock"} className={`${inputClass} bg-white`}>
                {(["exact", "in_stock", "yes_no"] as const).map((m) => (
                  <option key={m} value={m}>
                    {dict.dashboard[`mode_${m}`]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={dict.dashboard.threshold}>
              <input
                name="low_stock_threshold"
                type="number"
                min={1}
                max={50}
                defaultValue={shop?.low_stock_threshold ?? 3}
                className={`${inputClass} w-24`}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="is_active" defaultChecked={shop?.is_active ?? false} />
            {dict.admin.active}
          </label>
          <button type="submit" className="self-start rounded border border-foreground px-4 py-2 font-medium">
            {dict.account.save}
          </button>
        </form>
      </Section>

      {!shop ? (
        <p className="text-muted">{dict.admin.save_first}</p>
      ) : (
        <>
          <Section title={dict.admin.owners_title}>
            {owners.length === 0 ? (
              <p className="text-muted">{dict.admin.no_owners}</p>
            ) : (
              <ul className="divide-y divide-line border-y border-line">
                {owners.map((o) => (
                  <li key={o.user_id} className="flex items-center justify-between gap-3 py-2">
                    <span>{o.email}</span>
                    <form action={removeOwner}>
                      {hidden}
                      <input type="hidden" name="user_id" value={o.user_id} />
                      <button type="submit" className="text-sm underline underline-offset-4">
                        {dict.admin.remove}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <form action={inviteOwner} className="flex flex-wrap items-end gap-2">
              {hidden}
              <Field label={dict.admin.invite_email}>
                <input name="email" type="email" required autoComplete="off" className={`${inputClass} w-72 max-w-full`} />
              </Field>
              <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium">
                {dict.admin.invite}
              </button>
            </form>
          </Section>

          <Section title={dict.admin.sync_title}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
              <dt className="text-muted">{dict.dashboard.latest_file}</dt>
              <dd>{shop.latest_file_time ? formatDateTime(shop.latest_file_time, lang, shop.timezone) : dict.account.never}</dd>
              <dt className="text-muted">{dict.admin.checked}</dt>
              <dd>{shop.last_checked_at ? formatDateTime(shop.last_checked_at, lang, shop.timezone) : dict.account.never}</dd>
              <dt className="text-muted">{dict.dashboard.state}</dt>
              <dd className="font-semibold">{dict.account[`state_${shop.freshness_state}`]}</dd>
              <dt className="text-muted">{dict.dashboard.last_error}</dt>
              <dd>{shop.last_error || dict.account.none}</dd>
            </dl>

            <form action={saveSyncSource} className="flex flex-col gap-3">
              {hidden}
              <div className="flex flex-wrap gap-3">
                <Field label={dict.admin.file_format}>
                  <select name="file_format" defaultValue={shop.file_format ?? "xml"} className={`${inputClass} bg-white`}>
                    <option value="xml">XML</option>
                    <option value="csv">CSV</option>
                    <option value="xlsx">Excel (xlsx)</option>
                  </select>
                </Field>
                <Field label={dict.admin.file_url}>
                  <input
                    name="file_url"
                    type="url"
                    placeholder="https://shop-name.example.com/stock.xml"
                    defaultValue={shop.file_url ?? ""}
                    className={`${inputClass} w-96 max-w-full`}
                  />
                </Field>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-sm">
                  {dict.admin.mapping}
                  {shop.field_mapping && (
                    <span className="font-semibold">
                      {" · "}
                      {shop.mapping_status === "confirmed" ? dict.admin.mapping_confirmed : dict.admin.mapping_proposed}
                    </span>
                  )}
                </span>
                {!shop.field_mapping && <p className="text-sm text-muted">{dict.admin.no_mapping}</p>}
                <textarea
                  name="field_mapping"
                  rows={6}
                  spellCheck={false}
                  defaultValue={shop.field_mapping ? JSON.stringify(shop.field_mapping, null, 2) : ""}
                  placeholder='{"source_code": "KOD", "name": "NAZOV", "ean": "EAN", "quantity": "MNOZSTVO", "price": "CENA"}'
                  className={`${inputClass} font-mono text-sm`}
                />
              </div>

              {shop.sample_rows && shop.sample_rows.length > 0 && <SampleRows rows={shop.sample_rows.slice(0, 10)} title={dict.admin.sample_rows} />}

              <div className="flex flex-wrap gap-2">
                <button type="submit" name="intent" value="save" className="rounded border border-line px-4 py-2">
                  {dict.admin.save_mapping}
                </button>
                <button type="submit" name="intent" value="approve" className="rounded border border-foreground px-4 py-2 font-medium">
                  {dict.admin.approve}
                </button>
              </div>
            </form>
          </Section>
        </>
      )}
    </div>
  );
}

function SampleRows({ rows, title }: { rows: Record<string, unknown>[]; title: string }) {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 12);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm">{title}</span>
      <div className="overflow-x-auto border border-line">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left">
              {columns.map((c) => (
                <th key={c} className="px-2 py-1 font-mono font-normal text-muted">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                {columns.map((c) => (
                  <td key={c} className="whitespace-nowrap px-2 py-1 font-mono">
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

function okText(dict: Dictionary, ok: string, email: string): string {
  if (ok === "invited") return t(dict.admin.invited, { email });
  if (ok === "linked") return t(dict.admin.linked, { email });
  return dict.account.saved;
}

function errText(dict: Dictionary, err: string): string {
  if (err === "invite_fn_missing") return dict.admin.invite_fn_missing;
  if (err === "mapping") return dict.admin.mapping_invalid;
  if (err === "slug") return `${dict.admin.slug}: ${dict.admin.slug_hint}`;
  if (err === "slug_taken") return dict.admin.slug_taken;
  if (err === "email") return dict.login.error_email;
  if (err.startsWith("invite:")) return t(dict.admin.invite_failed, { message: err.slice(7) });
  return t(dict.account.error, { message: err });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="border-b border-line pb-1 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}
