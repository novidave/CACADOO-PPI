import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { formatPrice, formatTime } from "@/lib/format";
import { payBySquareSvg } from "@/lib/payBySquare";
import { formatIban, formatQty, paymentMessage } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { PollRefresh } from "@/components/PollRefresh";
import { saleCancel, salePaid } from "../../actions";
import { btn, btnGhost, first, loadSklad, Notice, UUID } from "../../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/sale/[id]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.qr_title} · ${s.title}` };
}

export interface SaleJson {
  id: string;
  status: "pending" | "done" | "cancelled";
  payment: "cash" | "card" | "qr";
  total: number;
  pieces: number;
  vs: string;
  created_at: string;
  paid_at: string | null;
  location: string | null;
  paid_by: string | null;
  shop_name: string;
  timezone: string;
  payee: string;
  iban: string | null;
  bic: string | null;
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
    <div className="mx-auto flex w-full max-w-md flex-col gap-4" data-sklad-qr={sale.status}>
      <Link href={href("/sale")} className="flex min-h-11 items-center gap-2 font-semibold">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
        {s.qr_back}
      </Link>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-[26px] font-bold">{s.qr_title}</h1>
        <span className="text-muted">{s.qr_amount}</span>
        <strong className="text-[40px] leading-tight">{total}</strong>
      </div>

      {svg && (
        <figure className="flex flex-col items-center gap-2">
          <div
            role="img"
            aria-label={s.qr_alt.replace("{total}", total)}
            className="w-full max-w-[300px] [&>svg]:h-auto [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <figcaption className="text-sm font-semibold">{s.qr_caption}</figcaption>
        </figure>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-line p-4 text-[15px]">
        <dt className="text-muted">{s.qr_payee}</dt>
        <dd className="font-semibold">{sale.payee}</dd>
        {sale.iban && (
          <>
            <dt className="text-muted">{s.qr_iban}</dt>
            <dd className="font-mono font-semibold">{formatIban(sale.iban)}</dd>
          </>
        )}
        <dt className="text-muted">{s.qr_vs}</dt>
        <dd className="font-mono font-semibold">{sale.vs}</dd>
        <dt className="text-muted">{s.qr_message}</dt>
        <dd>{message}</dd>
      </dl>

      {sale.status === "pending" && (
        <div className="flex flex-col gap-3">
          <PollRefresh seconds={5} />
          <div role="status" className="flex items-center gap-2 font-bold">
            <span aria-hidden="true" className="inline-block size-3 rounded-full bg-[#F2B705] ring-2 ring-white ring-offset-1 ring-offset-[#B7860B]" />
            {s.qr_waiting}
          </div>
          <p className="text-sm text-muted">{s.qr_waiting_text}</p>
          {form(salePaid, s.qr_paid_btn, btn)}
          <div className="grid grid-cols-2 gap-2">
            <a href="#big" className={btnGhost}>
              {s.qr_bigger}
            </a>
            {form(saleCancel, s.qr_other, btnGhost, { other: "1" })}
          </div>
          {form(saleCancel, s.qr_cancel, "min-h-11 font-semibold underline underline-offset-4")}
        </div>
      )}

      {sale.status === "done" && (
        <div role="status" className="flex flex-col items-center gap-2 rounded-xl border border-[#1E9E5A] p-4 text-center" data-sklad-paid>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#1E9E5A" strokeWidth="2.4" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="m7.5 12.5 3 3 6-6.5" />
          </svg>
          <strong className="text-lg">{s.qr_paid}</strong>
          <span>
            {s.sale_done_text.replace("{location}", sale.location ?? "")}{" "}
            <strong>
              {formatQty(sale.pieces, "ks", ctx.lang)} · {total}
            </strong>
          </span>
          {sale.paid_at && (
            <span className="text-sm text-muted">
              {s.qr_paid_by.replace("{name}", sale.paid_by ?? "–").replace("{time}", formatTime(new Date(sale.paid_at), sale.timezone))}
            </span>
          )}
          <Link href={href("/sale")} className={`${btn} mt-1 w-full`}>
            {s.sale_new}
          </Link>
        </div>
      )}

      {sale.status === "cancelled" && (
        <div role="status" className="flex flex-col gap-3 rounded-xl border border-line p-4" data-sklad-cancelled>
          <p>{s.qr_cancelled}</p>
          <Link href={href("/sale")} className={btn}>
            {s.qr_back}
          </Link>
        </div>
      )}

      {svg && (
        <div
          id="big"
          role="dialog"
          aria-label={s.qr_scan_hint}
          className="fixed inset-0 z-50 hidden flex-col items-center justify-center gap-4 bg-white p-6 text-center target:flex"
        >
          <span className="text-lg font-semibold">{s.qr_scan_hint}</span>
          <strong className="text-[40px]">{total}</strong>
          <div className="w-full max-w-[min(90vw,70vh)] [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
          <span className="text-muted">
            {sale.payee} · VS {sale.vs}
          </span>
          <a href="#" className={btnGhost}>
            {s.qr_close}
          </a>
        </div>
      )}
    </div>
  );
}
