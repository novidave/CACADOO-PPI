import { randomUUID } from "node:crypto";
import { saleProducts, type SkladRow } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { type PrijemkaLabels, SkladPrijemka } from "@/components/SkladPrijemka";
import type { ReceiptJson } from "../actions";
import { type loadSklad, Notice, first, SkladShell } from "../parts";

const LIST = 500;
const PREFIXES = ["rc_", "ai_", "err_", "items_", "sale_"];

type Ctx = Extract<Awaited<ReturnType<typeof loadSklad>>, { ok: true }>;

/**
 * The receipt editor's page (a new receipt or a saved one): the products (the first 500 by name; a bigger shop's
 * search and scans ask the database), the locations, the known suppliers — all from SQL — and the texts it needs.
 */
export async function ReceiptEditor({ ctx, receipt, sp }: { ctx: Ctx; receipt: ReceiptJson | null; sp: Record<string, string | string[] | undefined> }) {
  const { dict, s, session, shop, shops } = ctx;
  const [prod, ov, sup] = await Promise.all([
    session.supabase.rpc("owner_sklad_products", { p_shop_id: shop.id, p_q: null, p_filter: "all", p_limit: LIST + 1, p_offset: 0 }),
    session.supabase.rpc("owner_sklad_overview", { p_shop_id: shop.id }),
    session.supabase.rpc("owner_sklad_suppliers", { p_shop_id: shop.id }),
  ]);
  const error = prod.error ?? ov.error ?? sup.error;
  if (error) return <DbError message={error.message} dict={dict} />;
  const res = prod.data as { rows: SkladRow[]; source: string };
  const o = ov.data as { locations: { id: string; name: string; receipt_default: boolean }[] };
  const labels = Object.fromEntries(Object.entries(s as Record<string, string>).filter(([k]) => PREFIXES.some((p) => k.startsWith(p)))) as PrijemkaLabels;
  const def = o.locations.find((l) => l.receipt_default)?.id ?? o.locations[0]?.id ?? "";
  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="receipts" source={res.source}>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />
      <SkladPrijemka
        lang={ctx.lang}
        shopId={shop.id}
        shopSlug={shop.slug}
        receipt={receipt}
        newId={randomUUID()}
        products={saleProducts(res.rows.slice(0, LIST))}
        complete={res.rows.length <= LIST}
        locations={o.locations.map((l) => ({ id: l.id, name: l.name }))}
        defaultLocation={def}
        suppliers={(sup.data as string[]) ?? []}
        links={{
          list: ctx.href("/receipts"),
          receiptPath: `/${ctx.lang}/dashboard/sklad/receipts`,
          query: new URLSearchParams({ shop: shop.slug }).toString(),
          movements: ctx.href("/movements", { kind: "receipt" }),
        }}
        labels={labels}
      />
    </SkladShell>
  );
}
