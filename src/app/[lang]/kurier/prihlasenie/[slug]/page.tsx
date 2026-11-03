import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { createPublicClient } from "@/lib/supabase/public";
import { buttonClass, cardClass, Field, fieldClass } from "@/components/owner/ui";
import { courierLogin, sendCourierCode } from "./actions";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The shop's courier login (database update 75): the address in the invitation SMS (no key in it). The number → an SMS
 * code → the phone is signed in for 30 days. No Cacaduu account, no password.
 */
export default async function CourierLoginPage({ params, searchParams }: PageProps<"/[lang]/kurier/prihlasenie/[slug]">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const c = (await getDictionary(lang)).courier;
  const client = createPublicClient();
  const { data } = client ? await client.rpc("food_courier_shop", { p_slug: slug }) : { data: null };
  const shop = data as { slug: string; name: string; available: boolean } | null;
  if (!shop) notFound();
  const texts = c as Record<string, string>;
  const err = first(sp.err);
  const codeId = first(sp.code);
  const to = first(sp.to) ?? "";
  const test = first(sp.test);
  const left = first(sp.left);
  const errText = err ? (texts[`err_${err}`] ?? c.err_failed).replace("{n}", left ?? "") : null;
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="slug" value={shop.slug} />
    </>
  );

  return (
    <section className={cardClass} data-courier-login>
      <span className="text-[13px] font-semibold text-[#5C5C5C]">{c.shop_courier.replace("{shop}", shop.name)}</span>
      <h1 className="text-[24px] font-bold leading-tight">{c.login_title}</h1>
      {!shop.available ? (
        <p className="text-[15px]" data-courier-unavailable>
          {c.unavailable}
        </p>
      ) : codeId && UUID.test(codeId) ? (
        <form action={courierLogin} className="flex flex-col gap-3">
          {hidden}
          <input type="hidden" name="code_id" value={codeId} />
          <input type="hidden" name="to" value={to} />
          <p className="text-[15px]" role="status">
            {c.code_sent.replace("{phone}", to)}
          </p>
          {test && <p className="rounded-xl bg-[#F6F6F6] p-3 text-sm font-semibold">{c.test_code.replace("{code}", test)}</p>}
          <Field label={c.code}>
            <input
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,8}"
              maxLength={8}
              className={`${fieldClass} text-center text-[24px] tracking-[0.3em]`}
            />
          </Field>
          {errText && (
            <p role="alert" className="text-[15px] text-[#B42318]">
              {errText}
            </p>
          )}
          <button type="submit" className={buttonClass}>
            {c.sign_in}
          </button>
          <a href={`/${lang}/kurier/prihlasenie/${shop.slug}`} className="flex min-h-11 items-center self-start text-[15px] font-semibold underline underline-offset-4">
            {c.other_number}
          </a>
        </form>
      ) : (
        <form action={sendCourierCode} className="flex flex-col gap-3">
          {hidden}
          <p className="text-[15px]">{c.login_intro}</p>
          <Field label={c.phone}>
            <input name="phone" type="tel" required autoComplete="tel" maxLength={40} className={fieldClass} />
          </Field>
          {errText && (
            <p role="alert" className="text-[15px] text-[#B42318]">
              {errText}
            </p>
          )}
          <button type="submit" className={buttonClass}>
            {c.send_code}
          </button>
        </form>
      )}
    </section>
  );
}
