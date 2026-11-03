import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { courierWhoami, type CourierOrder, type CourierPay, type CourierWhoami } from "@/lib/courier";
import { money } from "@/lib/foodRules";
import { ghostClass } from "@/components/owner/ui";

/**
 * The courier app's shared parts (database update 75; canvas "Asistent a CRM" boards 15–18, "Môj obchod" artboard 20).
 * One column for the phone, no menu: Moje donášky · QR terminál · Hotovosť. Everything shown comes from the courier's
 * own door (food_courier_call); nothing is decided here.
 */

export type CourierTexts = Dictionary["courier"];

export async function loadCourier(langValue: string) {
  if (!isLocale(langValue)) notFound();
  const lang: Locale = langValue;
  const dict = await getDictionary(lang);
  const me = await courierWhoami();
  return { lang, dict, c: dict.courier, f: dict.food, me };
}

/** "18:35" in the shop's time zone. */
export function hhmm(iso: string | null | undefined, lang: string, timeZone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(lang, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export const eur = (cents: number, lang: string) => money(cents, lang);

/** "2 položky" (Intl plurals: one / few / many). */
export function itemsText(c: CourierTexts, n: number, lang: string): string {
  const rule = new Intl.PluralRules(lang).select(n);
  const t = rule === "one" ? c.items_one : rule === "few" ? c.items_few : c.items_many;
  return t.replace("{n}", String(n));
}

export function payLabel(c: CourierTexts, method: CourierPay): string {
  return method === "qr" ? c.pay_qr : method === "cash" ? c.pay_cash : c.pay_card;
}

/** Google Maps directions to one delivery (its point, else its written address). */
export function directionsTo(o: Pick<CourierOrder, "lat" | "lng" | "address">): string | null {
  const place = o.lat !== null && o.lng !== null ? `${o.lat},${o.lng}` : o.address;
  return place ? `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(place)}` : null;
}

/** "Navigovať celú trasu": the deliveries in order, the last one the destination, the rest waypoints. */
export function routeUrl(orders: Pick<CourierOrder, "lat" | "lng" | "address">[]): string | null {
  const places = orders
    .map((o) => (o.lat !== null && o.lng !== null ? `${o.lat},${o.lng}` : o.address))
    .filter((p): p is string => Boolean(p));
  if (places.length === 0) return null;
  const destination = places[places.length - 1];
  const waypoints = places.slice(0, -1).slice(0, 9);
  const params = new URLSearchParams({ api: "1", travelmode: "driving", destination });
  if (waypoints.length) params.set("waypoints", waypoints.join("|"));
  return `https://www.google.com/maps/dir/?${params}`;
}

/** The top of every courier screen: the shop · kuriér, the courier's name, and a way back. */
export function CourierHead({ lang, c, me, back, title }: { lang: string; c: CourierTexts; me: CourierWhoami; back?: string; title?: string }) {
  return (
    <header className="flex flex-col gap-1" data-courier-head>
      {back && (
        <Link href={back} className="flex min-h-11 items-center gap-1 self-start text-[15px] font-semibold" data-courier-back>
          <span aria-hidden="true">←</span> {c.back}
        </Link>
      )}
      <span className="text-[13px] font-semibold text-[#5C5C5C]">{c.shop_courier.replace("{shop}", me.shop.name)}</span>
      <h1 className="text-[24px] font-bold leading-tight">{title ?? me.courier.name}</h1>
      {!back && <span lang={lang} className="sr-only">{c.title}</span>}
    </header>
  );
}

/** Not signed in (no key, ended, expired): only the way back through the SMS invitation. */
export function NotSignedIn({ c }: { c: CourierTexts }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[#E4E4E4] p-[18px]" data-courier-signed-out>
      <h1 className="text-[24px] font-bold">{c.login_title}</h1>
      <p className="text-[15px]">{c.not_signed_in}</p>
    </div>
  );
}

/** A message from ?ok= / ?err= after a step without JavaScript. */
export function CourierNotice({ c, err }: { c: CourierTexts; err?: string }) {
  if (!err) return null;
  const texts = c as Record<string, string>;
  return (
    <p role="alert" className="rounded-xl border border-[#D64545] p-3 text-[15px]" data-courier-err={err}>
      {texts[`err_${err}`] ?? c.err_failed}
    </p>
  );
}

export function SignOut({ lang, c }: { lang: string; c: CourierTexts }) {
  return (
    <form action="/api/kurier/logout" method="post">
      <input type="hidden" name="lang" value={lang} />
      <button type="submit" className={`${ghostClass} w-full`} data-courier-sign-out>
        {c.sign_out}
      </button>
    </form>
  );
}

/** The words a step button shows while sending and for each refusal. */
export function stepLabels(c: CourierTexts) {
  return {
    sending: c.sending,
    retrying: c.retrying,
    failed: c.err_failed,
    errors: {
      step: c.err_step, not_paid: c.err_not_paid, pay_method: c.err_pay_method, cash: c.err_cash, reason: c.err_reason,
      courier: c.err_courier, already_paid: c.err_already_paid, too_many: c.err_too_many,
    } as Record<string, string>,
  };
}
