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
}) {
  const o = dict.owner;
  const zones = europeanTimeZones();
  const timezone = shop?.timezone ?? (zones.includes(defaults.timezone) ? defaults.timezone : "");
  // "Krátke / Dlhé" for each contact button on the shop page (update 51).
  const widths = contactWidths(shop?.contact_buttons);
  const width = (key: ContactKey) => <WidthToggle name={`cb_${key}`} value={widths[key]} labels={dict.contact_buttons} />;
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop?.id ?? ""} />
      <input type="hidden" name="shop_slug" value={shop?.slug ?? ""} />
      {first}
      {/* artboard 9: the details on the left, the hours and the switches on the right (one column on a phone) */}
      <div className="grid gap-[18px] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-3" data-shop-form-details>
      <Field label={o.shop_name}>
        <input name="name" required maxLength={200} defaultValue={shop?.name ?? ""} className={inputClass} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={o.address}>
          <input name="address" maxLength={200} defaultValue={shop?.address ?? ""} className={inputClass} />
        </Field>
        <Field label={o.zip}>
          <input name="zip" maxLength={12} autoComplete="postal-code" defaultValue={shop?.zip ?? ""} className={`${inputClass} w-32`} />
        </Field>
        <Field label={o.city}>
          <input name="city" required maxLength={100} defaultValue={shop?.city ?? ""} className={inputClass} />
        </Field>
      </div>
      {/* The company behind the shop, under the address (update 47). */}
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
        <div className="sm:col-span-2">
          <Field label={o.company_name}>
            <input name="company_name" maxLength={200} autoComplete="organization" defaultValue={shop?.company_name ?? ""} className={inputClass} />
          </Field>
        </div>
        <Field label={o.ico}>
          <input name="ico" maxLength={40} defaultValue={shop?.ico ?? ""} className={inputClass} />
        </Field>
        <Field label={o.dic}>
          <input name="dic" maxLength={20} defaultValue={shop?.dic ?? ""} className={inputClass} />
        </Field>
      </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
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
        <Field label={o.timezone}>
          <select name="timezone" required defaultValue={timezone} className={`${inputClass} bg-white`}>
            <option value="">{o.timezone_pick}</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex flex-col gap-1">
          <Field label={dict.dashboard.phone}>
            <input name="phone" type="tel" maxLength={40} defaultValue={shop?.phone ?? ""} className={inputClass} />
          </Field>
          {width("phone")}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Field label={dict.dashboard.website}>
          <input name="website" type="url" placeholder="https://" defaultValue={shop?.website ?? ""} className={inputClass} />
        </Field>
        {width("web")}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Field label={dict.dashboard.email}>
            <input name="email" type="email" maxLength={254} defaultValue={shop?.email ?? ""} className={inputClass} />
          </Field>
          {width("email")}
        </div>
        <div className="flex flex-col gap-1">
          <Field label={dict.dashboard.facebook} hint={dict.dashboard.facebook_hint}>
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
          {width("facebook")}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Field label={dict.dashboard.booking} hint={dict.dashboard.booking_hint}>
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
        {width("booking")}
      </div>
      <p className="text-xs text-muted">{dict.contact_buttons.width_hint}</p>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-semibold">{o.location}</legend>
        <LocationPicker
          initial={{ lat: shop?.lat ?? null, lng: shop?.lng ?? null }}
          labels={{ lat: o.lat, lng: o.lng, hint: o.map_hint, map: o.location }}
        />
        {/* "Navigovať" leads to this position (else to the address) */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{dict.shop.directions}</span>
          {width("navigate")}
        </div>
      </fieldset>
      </div>

      <div id="hours" className="flex min-w-0 scroll-mt-4 flex-col gap-3" data-shop-form-hours>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold">{dict.dashboard.hours}</span>
        <HoursEditor
          name="opening_hours"
          initial={shop?.opening_hours ?? null}
          dayNames={Object.fromEntries(DAYS.map((d) => [d, dayName(d, lang)])) as Record<DayKey, string>}
          labels={{
            closed: dict.dashboard.closed_day,
            add: dict.dashboard.add_range,
            remove: dict.dashboard.remove_range,
            add_break: dict.dashboard.add_break,
            break_from: dict.dashboard.break_from,
            break_to: dict.dashboard.break_to,
            break_add: dict.dashboard.break_add,
            break_cancel: dict.dashboard.break_cancel,
            break_outside: dict.dashboard.break_outside,
            past_midnight: dict.dashboard.past_midnight,
          }}
        />
      </div>

      {/* Vybavenie and "Viditeľný pre zákazníkov" (artboard 9): switches, 56 px rows */}
      <fieldset className={`${cardClass} gap-0 py-2`}>
        <legend className="sr-only">{dict.dashboard.amenities_title}</legend>
        <span aria-hidden="true" className="pt-2 text-sm font-semibold">{dict.dashboard.amenities_title}</span>
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="text-[13px] text-[#5C5C5C]">{hint}</span>}
    </label>
  );
}

/** "Tlačidlo na stránke: Krátke | Dlhé" — two radios that look like one switch (update 51). */
function WidthToggle({
  name,
  value,
  labels,
}: {
  name: string;
  value: "short" | "long";
  labels: { width_label: string; width_short: string; width_long: string };
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-width-toggle={name}>
      <legend className="sr-only">{labels.width_label}</legend>
      <span aria-hidden="true" className="whitespace-nowrap text-muted">
        {labels.width_label}:
      </span>
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
