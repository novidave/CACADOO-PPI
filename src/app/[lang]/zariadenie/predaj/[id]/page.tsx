import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { formatPrice } from "@/lib/format";
import { payBySquareSvg } from "@/lib/payBySquare";
import { paymentMessage } from "@/lib/sklad";
import { type SaleJson, SaleQrView } from "@/app/[lang]/(account)/dashboard/sklad/SaleQrView";
import { deviceSaleCancel, deviceSalePaid } from "../../actions";
import { can, DeviceShell, loadDevice, NotPaired } from "../../device";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: PageProps<"/[lang]/zariadenie/predaj/[id]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).sklad.qr_title };
}

/** "Platba QR" on a paired phone (database update 72): the same page as Môj obchod, the phone's own actions. */
export default async function DeviceSaleQr({ params, searchParams }: PageProps<"/[lang]/zariadenie/predaj/[id]">) {
  const { lang, id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const { s, d, device, rpc, lang: l } = await loadDevice(lang);
  if (!device || !rpc) return <NotPaired lang={l} d={d} />;
  if (!can(device, "sale") && !can(device, "terminal")) notFound();
  const { data, error } = await rpc("owner_sklad_sale", { p_sale_id: id });
  if (error || !data) notFound();
  const sale = data as SaleJson;
  const total = formatPrice(sale.total, l, "EUR");
  const message = paymentMessage(s.message_word, new Date(sale.created_at), sale.timezone, l);
  const svg =
    sale.payment === "qr" && sale.status === "pending" && sale.iban
      ? await payBySquareSvg({ iban: sale.iban, bic: sale.bic, payee: sale.payee, amount: sale.total, vs: sale.vs, message })
      : null;
  return (
    <DeviceShell lang={l} d={d} device={device}>
      <SaleQrView
        s={s}
        lang={l}
        sale={sale}
        svg={svg}
        total={total}
        message={message}
        backHref={`/${l}/zariadenie/predaj`}
        ok={typeof sp.ok === "string" ? sp.ok : undefined}
        err={typeof sp.err === "string" ? sp.err : undefined}
        form={(kind, label, cls) => (
          <form action={kind === "paid" ? deviceSalePaid : deviceSaleCancel}>
            <input type="hidden" name="lang" value={l} />
            <input type="hidden" name="sale_id" value={sale.id} />
            {kind === "other" && <input type="hidden" name="other" value="1" />}
            <button type="submit" className={`${cls} w-full`}>
              {label}
            </button>
          </form>
        )}
      />
    </DeviceShell>
  );
}
