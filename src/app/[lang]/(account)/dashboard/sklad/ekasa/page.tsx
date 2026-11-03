import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import type { SkladRow } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { forgetEkasa, pairEkasa, uploadEkasa } from "../actions";
import { btnGhost, card, first, loadSklad, Notice, SkladShell } from "../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/ekasa">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.ek_title} · ${s.title}` };
}

interface Info {
  sale_source: string;
  columns: Record<string, string> | null;
  waiting_texts: number;
  waiting_lines: number;
  imports: { id: string; file_name: string; at: string; docs: number; lines: number; booked: number; unmatched: number; ignored: number; skipped: number; pieces: number }[];
  pairs: { key: string; ignore: boolean; item_id: string | null; name: string | null }[];
}

interface Waiting {
  key: string;
  text: string;
  lines: number;
  pieces: number;
  code: string | null;
  ean: string | null;
  candidates: { id: string; name: string; code: string | null }[];
}

const input = "min-h-11 rounded-xl border border-[#D6D6D6] px-3 text-[16px] outline-none focus:border-foreground";
const FIELDS = ["product", "qty", "doc", "time", "price", "code", "ean"] as const;

/**
 * Sklad → Import z eKasa (database update 71; Nastavenia screen 15 "Odkiaľ prichádzajú predaje"): upload the cash
 * register's daily export, see what was booked, pair the lines that wait ("Spárovať") with a product or "Nie je tovar"
 * (remembered for the next exports), the last imports and the remembered pairings. Every decision is SQL's.
 */
export default async function SkladEkasa({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/ekasa">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, hidden, href } = ctx;
  const [info, waiting, overview] = await Promise.all([
    session.supabase.rpc("owner_sklad_ekasa_info", { p_shop_id: shop.id }),
    session.supabase.rpc("owner_sklad_ekasa_unmatched", { p_shop_id: shop.id }),
    session.supabase.rpc("owner_sklad_overview", { p_shop_id: shop.id }),
  ]);
  if (info.error) return <DbError message={info.error.message} dict={dict} />;
  if (waiting.error) return <DbError message={waiting.error.message} dict={dict} />;
  const i = info.data as Info;
  const rows = (waiting.data ?? []) as Waiting[];
  const source = ((overview.data ?? {}) as { source?: string }).source ?? "file";
  // "Vybrať iný produkt": a search for one waiting text (?for=<key>&q=<words>)
  const forKey = first(sp.for) ?? "";
  const q = (first(sp.q) ?? "").trim().slice(0, 80);
  const found =
    forKey && q
      ? ((await session.supabase.rpc("owner_sklad_products", { p_shop_id: shop.id, p_q: q, p_filter: "all", p_limit: 8, p_offset: 0 })).data as { rows: SkladRow[] } | null)?.rows ?? []
      : [];
  const back = { back: "/ekasa" };
  const label = (f: (typeof FIELDS)[number]) => (s as Record<string, string>)[`ek_col_${f}`];
  const on = i.sale_source === "ekasa";

  const pairButton = (key: string, item: { id: string; name: string; code: string | null }) => (
    <form action={pairEkasa} key={item.id}>
      {hidden({ key, item_id: item.id, ...back })}
      <button type="submit" className={`${btnGhost} min-h-11 text-left text-[14px]`} data-sklad-pair={item.id}>
        {item.name}
        {item.code ? <span className="font-normal text-muted"> · {item.code}</span> : null}
      </button>
    </form>
  );

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="sale" source={source}>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold">{s.ek_title}</h2>
        <p className="text-sm text-muted">{s.ek_intro}</p>
      </div>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />

      {!on ? (
        <section className={card} data-sklad-ekasa-off>
          <p className="text-[15px]">{s.ek_off}</p>
          <Link href={href("/settings") + "#sales"} className={`${btnGhost} self-start`}>
            {s.ek_off_link}
          </Link>
        </section>
      ) : (
        <section className={card} aria-labelledby="ek-up" data-sklad-ekasa-upload>
          <h3 id="ek-up" className="text-lg font-bold">{s.ek_upload}</h3>
          <form action={uploadEkasa} className="flex flex-col gap-3">
            {hidden({ ...back })}
            <input type="file" name="file" required accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="text-[15px]" />
            <span className="text-[13px] text-muted">{s.ek_upload_hint}</span>
            {i.columns ? (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="pick_columns" value="1" className="size-5 accent-foreground" />
                {s.ek_pick_columns}
              </label>
            ) : null}
            <PendingButton pending={s.ek_uploading}>{s.ek_upload_button}</PendingButton>
          </form>
          {i.columns ? (
            <p className="text-[13px] text-muted" data-sklad-ekasa-columns>
              {s.ek_columns_ok}: {FIELDS.filter((f) => i.columns?.[f]).map((f) => `${label(f)} = „${i.columns?.[f]}“`).join(" · ")}
            </p>
          ) : (
            <p className="text-[13px] text-muted">{s.ek_columns_first}</p>
          )}
        </section>
      )}

      <section className={card} aria-labelledby="ek-wait" id="pair" data-sklad-ekasa-waiting={i.waiting_lines}>
        <h3 id="ek-wait" className="text-lg font-bold">
          {rows.length ? s.ek_wait_title.replace("{n}", String(i.waiting_lines)) : s.ek_wait_none}
        </h3>
        {rows.length > 0 && <p className="text-sm text-muted">{s.ek_wait_hint}</p>}
        <ul className="flex flex-col gap-3">
          {rows.map((w) => (
            <li key={w.key} className="flex flex-col gap-2 border-b border-line pb-3" data-sklad-wait={w.text}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong className="text-[15px]">{w.text}</strong>
                <span className="text-[13px] text-muted">
                  {s.ek_wait_line.replace("{lines}", String(w.lines)).replace("{pieces}", String(Number(w.pieces)))}
                  {w.code ? ` · ${s.ek_col_code} ${w.code}` : ""}
                  {w.ean ? ` · EAN ${w.ean}` : ""}
                </span>
              </div>
              {w.candidates.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-[13px] text-muted">{s.ek_candidates}</span>
                  <div className="flex flex-wrap gap-2">{w.candidates.map((c) => pairButton(w.key, c))}</div>
                </div>
              )}
              <details open={forKey === w.key}>
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold underline underline-offset-4">{s.ek_other}</summary>
                <form method="get" className="mt-2 flex gap-2">
                  <input type="hidden" name="shop" value={shop.slug} />
                  <input type="hidden" name="for" value={w.key} />
                  <input name="q" defaultValue={forKey === w.key ? q : ""} placeholder={s.ek_search_ph} className={`${input} min-w-0 flex-1`} />
                  <button type="submit" className={btnGhost}>
                    {s.ek_search}
                  </button>
                </form>
                {forKey === w.key && q ? (
                  found.length ? (
                    <div className="mt-2 flex flex-wrap gap-2">{found.map((r) => pairButton(w.key, { id: r.id, name: r.name, code: r.code }))}</div>
                  ) : (
                    <p className="mt-2 text-sm text-muted">
                      {s.ek_search_none}{" "}
                      <Link href={href("/products/new")} className="font-semibold text-foreground underline underline-offset-4">
                        {s.ek_new_product}
                      </Link>
                    </p>
                  )
                ) : null}
              </details>
              <form action={pairEkasa}>
                {hidden({ key: w.key, ignore: "1", ...back })}
                <button type="submit" className="min-h-11 text-sm text-muted underline underline-offset-4" data-sklad-ignore>
                  {s.ek_ignore}
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>

      <section className={card} aria-labelledby="ek-hist">
        <h3 id="ek-hist" className="text-lg font-bold">{s.ek_imports}</h3>
        {i.imports.length === 0 ? (
          <p className="text-sm text-muted">{s.ek_imports_none}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {i.imports.map((x) => (
              <li key={x.id} className="flex flex-col gap-0.5 py-2" data-sklad-import={x.id}>
                <span className="flex flex-wrap justify-between gap-2">
                  <strong className="text-[15px]">{formatDateTime(x.at, ctx.lang, shop.timezone)}</strong>
                  <span className="text-[13px] text-muted">{x.file_name}</span>
                </span>
                <span className="text-[13px]">
                  {s.ek_import_line
                    .replace("{docs}", String(x.docs))
                    .replace("{lines}", String(x.lines))
                    .replace("{pieces}", String(Number(x.pieces)))}
                  {x.unmatched ? ` · ${s.ek_import_waiting.replace("{n}", String(x.unmatched))}` : ""}
                  {x.skipped ? ` · ${s.ek_import_skipped.replace("{n}", String(x.skipped))}` : ""}
                  {x.ignored ? ` · ${s.ek_import_ignored.replace("{n}", String(x.ignored))}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link href={href("/movements", { kind: "sale" })} className="self-start text-sm font-semibold underline underline-offset-4">
          {s.sale_show_moves}
        </Link>
      </section>

      {i.pairs.length > 0 && (
        <details className={card}>
          <summary className="flex min-h-11 cursor-pointer items-center text-lg font-bold">
            {s.ek_pairs.replace("{n}", String(i.pairs.length))}
          </summary>
          <ul className="flex flex-col divide-y divide-line">
            {i.pairs.map((p) => (
              <li key={p.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-[14px]">
                  {p.key} → <strong>{p.ignore ? s.ek_not_goods : (p.name ?? "–")}</strong>
                </span>
                <form action={forgetEkasa}>
                  {hidden({ key: p.key, ...back })}
                  <button type="submit" className="min-h-11 text-sm underline underline-offset-4">
                    {s.ek_forget}
                  </button>
                </form>
              </li>
            ))}
          </ul>
          <span className="text-[13px] text-muted">{s.ek_forget_hint}</span>
        </details>
      )}
      <p className="text-[13px] text-muted">{s.ek_private}</p>
    </SkladShell>
  );
}
