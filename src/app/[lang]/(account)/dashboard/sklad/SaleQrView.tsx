import Link from "next/link";
import type { ReactNode } from "react";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { formatTime } from "@/lib/format";
import { formatIban, formatQty } from "@/lib/sklad";
import { PollRefresh } from "@/components/PollRefresh";
import { btn, btnGhost, Notice } from "./parts";

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
 * "Platba QR" (screen PlatbaQR), shared by Môj obchod and a paired phone (database update 72): the amount, the PAY by
 * square code (drawn on the server), the payee, IBAN, variable symbol and message; while the sale waits: "Zaplatené –
 * potvrdiť predaj", a bigger code for the customer (a plain #big target, no script), "Zaplatí inak" and "Zrušiť
 * predaj". The page reads itself again every 5 s. The forms come from the page (each its own action and way back).
 */
export function SaleQrView({
  s,
  lang,
  sale,
  svg,
  total,
  message,
  backHref,
  ok,
  err,
  form,
}: {
  s: Dictionary["sklad"];
  lang: Locale;
  sale: SaleJson;
  svg: string | null;
  total: string;
  message: string;
  backHref: string;
  ok?: string;
  err?: string;
  form: (kind: "paid" | "other" | "cancel", label: string, cls: string) => ReactNode;
}) {
  const ctx = { lang };
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4" data-sklad-qr={sale.status}>
      <Link href={backHref} className="flex min-h-11 items-center gap-2 font-semibold">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
        {s.qr_back}
      </Link>
      <Notice s={s} ok={ok} err={err} />
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
          {form("paid", s.qr_paid_btn, btn)}
          <div className="grid grid-cols-2 gap-2">
            <a href="#big" className={btnGhost}>
              {s.qr_bigger}
            </a>
            {form("other", s.qr_other, btnGhost)}
          </div>
          {form("cancel", s.qr_cancel, "min-h-11 font-semibold underline underline-offset-4")}
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
          <Link href={backHref} className={`${btn} mt-1 w-full`}>
            {s.sale_new}
          </Link>
        </div>
      )}

      {sale.status === "cancelled" && (
        <div role="status" className="flex flex-col gap-3 rounded-xl border border-line p-4" data-sklad-cancelled>
          <p>{s.qr_cancelled}</p>
          <Link href={backHref} className={btn}>
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
