import Link from "next/link";
import { redirect } from "next/navigation";
import { courierCall, type CourierDeliveries } from "@/lib/courier";
import { ghostClass } from "@/components/owner/ui";
import { CourierHead, loadCourier, NotSignedIn } from "../parts";

/** "QR terminál": the delivery that waits for a QR payment (the one on the way first), else a short note. */
export default async function CourierQrPick({ params }: PageProps<"/[lang]/kurier/qr">) {
  const { lang: value } = await params;
  const { lang, c, me } = await loadCourier(value);
  if (!me) return <NotSignedIn c={c} />;
  const { data } = await courierCall<CourierDeliveries>("deliveries");
  const open = (data?.open ?? []).filter((o) => !o.paid && o.pay_method === "qr");
  const pick = open.find((o) => o.status === "on_the_way") ?? open[0];
  if (pick && me.perms.qr) redirect(`/${lang}/kurier/d/${pick.id}/qr`);
  return (
    <>
      <CourierHead lang={lang} c={c} me={me} back={`/${lang}/kurier`} title={c.qr_terminal} />
      <p className="rounded-2xl border border-[#E4E4E4] p-[18px] text-[15px]" data-courier-qr-none>
        {c.qr_none}
      </p>
      <Link href={`/${lang}/kurier/donasky`} className={ghostClass}>
        {c.my_deliveries}
      </Link>
    </>
  );
}
