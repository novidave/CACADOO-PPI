import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { formatPrice } from "@/lib/format";
import { payBySquareSvg } from "@/lib/payBySquare";
import { paymentMessage } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { saleCancel, salePaid } from "../../actions";
import { type SaleJson, SaleQrView } from "../../SaleQrView";
import { first, loadSklad, SkladShell, UUID } from "../../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/sale/[id]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.qr_title} · ${s.title}` };
}


/**
 * "Platba QR" (screen PlatbaQR): the amount, the PAY by square code (drawn on the server), the payee, IBAN, variable
 * symbol and message; while the sale waits: "Zaplatené – potvrdiť predaj", a bigger code for the customer (a plain
 * #big target, no script), "Zaplatí inak" (cancels this QR sale and returns to the basket) and "Zrušiť predaj". The
 * page reads itself again every 5 s, so a payment confirmed on the QR terminal shows here too.
 */
export default async function SkladSaleQr({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/sale/[id]">) {
  const { lang, id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, hidden, href } = ctx;
  const { data, error } = await session.supabase.rpc("owner_sklad_sale", { p_shop_id: shop.id, p_sale_id: id });
  if (error) return <DbError message={error.message} dict={dict} />;
  if (!data) notFound();
  const sale = data as SaleJson;
  const total = formatPrice(sale.total, ctx.lang, "EUR");
  const message = paymentMessage(s.message_word, new Date(sale.created_at), sale.timezone, ctx.lang);
  const svg =
    sale.payment === "qr" && sale.status === "pending" && sale.iban
      ? await payBySquareSvg({ iban: sale.iban, bic: sale.bic, payee: sale.payee, amount: sale.total, vs: sale.vs, message })
      : null;
  const form = (action: (f: FormData) => Promise<void>, label: string, cls: string, extra: Record<string, string> = {}) => (
    <form action={action}>
      {hidden({ sale_id: sale.id, back: `/sale/${sale.id}`, ...extra })}
      <button type="submit" className={`${cls} w-full`}>
        {label}
      </button>
    </form>
  );

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={ctx.shops} shop={shop} current="sale" source={null} wide>
    <SaleQrView
      s={s}
      lang={ctx.lang}
      sale={sale}
      svg={svg}
      total={total}
      message={message}
      backHref={href("/sale")}
      ok={first(sp.ok)}
      err={first(sp.err)}
      form={(kind, label, cls) =>
        form(kind === "paid" ? salePaid : saleCancel, label, cls, kind === "other" ? { other: "1" } : {})
      }
      heading="h2"
    />
    </SkladShell>
  );
}
