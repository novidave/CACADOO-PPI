import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { EKASA_FIELDS, guessColumns, type EkasaColumns, type EkasaField } from "@/lib/ekasa";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { saveEkasaColumns } from "../../actions";
import { btnGhost, card, first, loadSklad, Notice, SkladShell } from "../../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/ekasa/columns">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.ek_columns_title} · ${s.title}` };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const select = "min-h-11 w-full rounded-xl border border-[#D6D6D6] bg-white px-3 text-[16px] outline-none focus:border-foreground";
const REQUIRED: EkasaField[] = ["product", "qty"];

/**
 * "Stĺpce exportu" (database update 71): the first eKasa export (or one with other columns) waits here until the owner
 * says which column is the product, the quantity and the receipt number or time (price, code and EAN optional). The
 * names are guessed from the file's own headers; the first 5 rows are shown as written. Saving keeps the choice and
 * books the file.
 */
export default async function EkasaColumns({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/ekasa/columns">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, hidden, href } = ctx;
  const id = first(sp.id) ?? "";
  const [st, info] = await Promise.all([
    UUID.test(id) ? session.supabase.rpc("owner_sklad_ekasa_staged", { p_shop_id: shop.id, p_id: id, p_limit: 5 }) : Promise.resolve({ data: null, error: null }),
    session.supabase.rpc("owner_sklad_ekasa_info", { p_shop_id: shop.id }),
  ]);
  if (st.error) return <DbError message={st.error.message} dict={dict} />;
  const file = st.data as { file_name: string; headers: string[]; rows: string[][]; count: number } | null;
  const saved = ((info.data ?? {}) as { columns?: EkasaColumns | null }).columns ?? {};
  const label = (f: EkasaField) => (s as Record<string, string>)[`ek_col_${f}`];

  if (!file) {
    return (
      <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="sale" source={null}>
        <section className={card}>
          <p>{s.ek_staged_gone}</p>
          <Link href={href("/ekasa")} className={`${btnGhost} self-start`}>
            {s.ek_title}
          </Link>
        </section>
      </SkladShell>
    );
  }
  const guess = guessColumns(file.headers);
  const preset = (f: EkasaField) => (saved[f] && file.headers.includes(saved[f] as string) ? saved[f] : guess[f]) ?? "";

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="sale" source={null}>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold">{s.ek_columns_title}</h2>
        <p className="text-sm text-muted">
          {file.file_name} · {s.ek_rows.replace("{n}", String(file.count))}
        </p>
      </div>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />
      <form action={saveEkasaColumns} className={card} data-sklad-ekasa-columns-form>
        {hidden({ id, back: "/ekasa/columns" })}
        <p className="text-sm">{s.ek_columns_hint}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {EKASA_FIELDS.map((f) => (
            <label key={f} className="flex flex-col gap-1 text-[15px]">
              <strong>
                {label(f)}
                {REQUIRED.includes(f) ? " *" : f === "doc" || f === "time" ? " **" : ""}
              </strong>
              <select name={`col_${f}`} defaultValue={preset(f)} required={REQUIRED.includes(f)} className={select} data-sklad-col={f}>
                <option value="">{s.ek_col_none}</option>
                {file.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <p className="text-[13px] text-muted">* {s.ek_col_required} · ** {s.ek_col_doc_or_time}</p>
        <PendingButton pending={s.ek_uploading}>{s.ek_columns_save}</PendingButton>
      </form>

      <section className={card} aria-labelledby="ek-prev">
        <h3 id="ek-prev" className="text-lg font-bold">{s.ek_preview}</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line">
                {file.headers.map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-2 py-1 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {file.rows.map((r, n) => (
                <tr key={n} className="border-b border-line">
                  {file.headers.map((h, c) => (
                    <td key={h} className="whitespace-nowrap px-2 py-1">
                      {r[c] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="text-[13px] text-muted">{s.ek_private}</span>
      </section>
    </SkladShell>
  );
}
