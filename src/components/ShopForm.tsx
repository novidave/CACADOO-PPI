import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { DAYS, dayName, type DayKey } from "@/lib/hours";
import type { MyShop } from "@/lib/myShops";
import { contactWidths, type ContactKey } from "@/lib/contactButtons";
import { europeanTimeZones } from "@/lib/timezones";
import { HoursEditor } from "./HoursEditor";
import { LocationPicker } from "./LocationPicker";
import { PendingButton } from "./PendingButton";
import { SaveBar } from "./owner/SaveBar";
import { cardClass, fieldClass, Toggle } from "./owner/ui";

// back-end layout L3: the owner pages' field (@/components/owner/ui)
const inputClass = fieldClass;

/** The shop's details, for a new shop (shop = null) or an existing one. */
export function ShopForm({
  dict,
  lang,
  shop,
  defaults,
  action,
  submitLabel,
  companyElsewhere,
  first,
  logo,
  kind,
}: {
  dict: Dictionary;
  lang: Locale;
  shop: MyShop | null;
  defaults: { country: string; timezone: string };
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
  /** Back-end layout L2: an existing shop's company name, IČO and DIČ are edited on Právne informácie (this link); the
   * form carries their current values unchanged, so saving the details never clears them. */
  companyElsewhere?: { href: string; label: string; hint: string };
  /** A new shop's first question (update 79: "Aký je to obchod?"), inside the form before the details. */
  first?: React.ReactNode;
  /** An existing shop: the logo row (its inputs belong to the logo's own form through `form=`), under the contacts. */
  logo?: React.ReactNode;
  /** An existing shop: "Typ obchodu" (its inputs belong to its own form through `form=`), last in the card. */
  kind?: React.ReactNode;
}) {
  const o = dict.owner;
  const dd = dict.dashboard;
  const zones = europeanTimeZones();
  const timezone = shop?.timezone ?? (zones.includes(defaults.timezone) ? defaults.timezone : "");
  // "Krátke / Dlhé" for each contact button on the shop page (update 51).
  const widths = contactWidths(shop?.contact_buttons);
  const widthRows: [ContactKey, string][] = [
    ["phone", dd.phone],
    ["email", dd.email],
    ["web", dd.website],
    ["facebook", dd.facebook],
    ["booking", dd.booking],
    ["navigate", dict.shop.directions],
  ];
  return (
    <form action={action} className="flex flex-col gap-[18px]" data-shop-form>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop?.id ?? ""} />
      <input type="hidden" name="shop_slug" value={shop?.slug ?? ""} />
      {first}
      {/* artboard 9: "Údaje obchodu" on the left, the hours and the switches on the right (one column below 1024 px) */}
      <div className="grid gap-[18px] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start">
        <section className={`${cardClass} min-w-0`} aria-labelledby="shop-details-title" data-shop-form-details>
          <h2 id="shop-details-title" className="text-[19px] font-bold">
            {dd.details_title}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={o.shop_name} wide>
              <input name="name" required maxLength={200} defaultValue={shop?.name ?? ""} className={inputClass} />
            </Field>
            <Field label={o.address}>
              <input name="address" maxLength={200} defaultValue={shop?.address ?? ""} className={inputClass} />
            </Field>
            <Field label={o.city}>
              <input name="city" required maxLength={100} defaultValue={shop?.city ?? ""} className={inputClass} />
            </Field>
            <Field label={dd.phone}>
              <input name="phone" type="tel" maxLength={40} defaultValue={shop?.phone ?? ""} className={inputClass} />
            </Field>
            <Field label={dd.email}>
              <input name="email" type="email" maxLength={254} defaultValue={shop?.email ?? ""} className={inputClass} />
            </Field>
            <Field label={dd.website}>
              <input name="website" type="url" placeholder="https://" defaultValue={shop?.website ?? ""} className={inputClass} />
            </Field>
            <Field label={dd.facebook} hint={dd.facebook_hint}>
              <input
                name="facebook_url"
                type="text"
                inputMode="url"
                autoComplete="url"
                maxLength={300}
                placeholder="https://www.facebook.com/"
                defaultValue={shop?.facebook_url ?? ""}
                className={inputClass}
              />
            </Field>
          </div>
          {logo}

          {/* what the artboard does not show, in today's order: PSČ, the company, country and time zone, the booking
              link, the contact buttons' width, the map position */}
          <div className="grid gap-3 border-t border-[#E4E4E4] pt-3.5 sm:grid-cols-2" data-shop-form-more>
            <Field label={o.zip}>
              <input name="zip" maxLength={12} autoComplete="postal-code" defaultValue={shop?.zip ?? ""} className={`${inputClass} w-32`} />
            </Field>
            <Field label={o.country} hint={o.country_hint}>
              <input
                name="country"
                required
                maxLength={2}
                pattern="[A-Za-z]{2}"
                defaultValue={shop?.country ?? defaults.country}
                className={`${inputClass} w-24 uppercase`}
              />
            </Field>
            <Field label={o.timezone} wide>
              <select name="timezone" required defaultValue={timezone} className={`${inputClass} bg-white`}>
                <option value="">{o.timezone_pick}</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {/* The company behind the shop (update 47). */}
          {companyElsewhere ? (
            <p className="text-sm text-muted" data-shop-company="elsewhere">
              <input type="hidden" name="company_name" value={shop?.company_name ?? ""} />
              <input type="hidden" name="ico" value={shop?.ico ?? ""} />
              <input type="hidden" name="dic" value={shop?.dic ?? ""} />
              {companyElsewhere.hint}{" "}
              <a href={companyElsewhere.href} className="font-semibold underline underline-offset-4">
                {companyElsewhere.label}
              </a>
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2" data-shop-company>
              <Field label={o.company_name} wide>
                <input name="company_name" maxLength={200} autoComplete="organization" defaultValue={shop?.company_name ?? ""} className={inputClass} />
              </Field>
              <Field label={o.ico}>
                <input name="ico" maxLength={40} defaultValue={shop?.ico ?? ""} className={inputClass} />
              </Field>
              <Field label={o.dic}>
                <input name="dic" maxLength={20} defaultValue={shop?.dic ?? ""} className={inputClass} />
              </Field>
            </div>
          )}
          <Field label={dd.booking} hint={dd.booking_hint}>
            <input
              name="booking_url"
              type="text"
              inputMode="url"
              autoComplete="url"
              maxLength={500}
              placeholder="https://"
              defaultValue={shop?.booking_url ?? ""}
              className={inputClass}
            />
          </Field>
          {/* "Krátke / Dlhé" per contact button (update 51), one row each */}
          <fieldset className="flex flex-col" data-width-rows>
            <legend className="mb-1 text-sm font-semibold">{dd.buttons_title}</legend>
            {widthRows.map(([key, label]) => (
              <div key={key} className="flex min-h-[52px] flex-wrap items-center justify-between gap-2 border-b border-[#E4E4E4] last:border-b-0">
                <span className="text-[15px] font-semibold">{label}</span>
                <WidthToggle name={`cb_${key}`} label={label} value={widths[key]} labels={dict.contact_buttons} />
              </div>
            ))}
            <p className="pt-1.5 text-xs text-muted">{dict.contact_buttons.width_hint}</p>
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-semibold">{o.location}</legend>
            <LocationPicker
              initial={{ lat: shop?.lat ?? null, lng: shop?.lng ?? null }}
              labels={{ lat: o.lat, lng: o.lng, hint: o.map_hint, map: o.location }}
            />
          </fieldset>
          {kind}
        </section>

        <div className="flex min-w-0 flex-col gap-[18px]">
          <section id="hours" className={`${cardClass} scroll-mt-4 gap-0`} aria-labelledby="shop-hours-title" data-shop-form-hours>
            <div className="flex items-center justify-between gap-3 pb-1.5">
              <h2 id="shop-hours-title" className="text-[19px] font-bold">
                {dd.hours}
              </h2>
              <span className="text-sm text-muted">{dd.hours_tap}</span>
            </div>
            <HoursEditor
              name="opening_hours"
              initial={shop?.opening_hours ?? null}
              dayNames={Object.fromEntries(DAYS.map((d) => [d, dayName(d, lang)])) as Record<DayKey, string>}
              shortNames={Object.fromEntries(DAYS.map((d) => [d, dayName(d, lang, "short")])) as Record<DayKey, string>}
              labels={{
                closed: dd.closed_day,
                add: dd.add_range,
                remove: dd.remove_range,
                add_break: dd.hours_add_break,
                break_from: dd.break_from,
                break_to: dd.break_to,
                break_outside: dd.break_outside,
                past_midnight: dd.past_midnight,
                from: dd.hours_from,
                to: dd.hours_to,
                done: dd.hours_done,
                close: dd.hours_close,
                edit: dd.hours_edit,
              }}
            />
          </section>

          {/* Vybavenie and "Viditeľný pre zákazníkov" (artboard 9): switches, 56 px rows */}
          <fieldset className={`${cardClass} gap-0 py-2 [&>label]:border-b [&>label]:border-[#E4E4E4] [&>label:last-child]:border-b-0`} data-shop-amenities>
            <legend className="sr-only">{dd.amenities_title}</legend>
            <Toggle name="has_card_terminal" label={dict.shop.card_terminal} defaultChecked={shop?.has_card_terminal ?? false} />
            <Toggle name="has_toilet" label={dict.shop.toilet} defaultChecked={shop?.has_toilet ?? false} />
            <Toggle name="has_douchette" label={dict.shop.douchette} defaultChecked={shop?.has_douchette ?? false} />
            <Toggle name="is_active" label={o.active} defaultChecked={shop?.is_active ?? true} />
          </fieldset>
        </div>
      </div>
      {/* an existing shop: the save bar sticks to the bottom (Neuložené zmeny · Zrušiť · Uložiť); a new one: one button */}
      {shop ? (
        <SaveBar labels={{ unsaved: o.unsaved, cancel: o.cancel_changes, save: submitLabel, saving: o.saving }} />
      ) : (
        <PendingButton pending={o.saving}>{submitLabel}</PendingButton>
      )}
    </form>
  );
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="text-[13px] text-[#5C5C5C]">{hint}</span>}
    </label>
  );
}

/** "Tlačidlo na stránke: Krátke | Dlhé" — two radios that look like one switch (update 51). */
function WidthToggle({
  name,
  label,
  value,
  labels,
}: {
  name: string;
  label: string;
  value: "short" | "long";
  labels: { width_label: string; width_short: string; width_long: string };
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-width-toggle={name}>
      <legend className="sr-only">{`${label}: ${labels.width_label}`}</legend>
      <span className="inline-flex flex-none overflow-hidden rounded-xl border border-[#D6D6D6]">
        {(["short", "long"] as const).map((w) => (
          <label key={w} className="cursor-pointer">
            <input type="radio" name={name} value={w} defaultChecked={value === w} className="peer sr-only" />
            <span className="flex min-h-11 items-center px-3.5 font-semibold peer-checked:bg-[#111] peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2">
              {w === "short" ? labels.width_short : labels.width_long}
            </span>
          </label>
        ))}
      </span>
    </fieldset>
  );
}
