import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { DAYS, dayName, type DayKey } from "@/lib/hours";
import type { MyShop } from "@/lib/myShops";
import { europeanTimeZones } from "@/lib/timezones";
import { HoursEditor } from "./HoursEditor";
import { LocationPicker } from "./LocationPicker";

const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

/** The shop's details, for a new shop (shop = null) or an existing one. */
export function ShopForm({
  dict,
  lang,
  shop,
  defaults,
  action,
  submitLabel,
}: {
  dict: Dictionary;
  lang: Locale;
  shop: MyShop | null;
  defaults: { country: string; timezone: string };
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
}) {
  const o = dict.owner;
  const zones = europeanTimeZones();
  const timezone = shop?.timezone ?? (zones.includes(defaults.timezone) ? defaults.timezone : "");
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop?.id ?? ""} />
      <input type="hidden" name="shop_slug" value={shop?.slug ?? ""} />
      <Field label={o.shop_name}>
        <input name="name" required maxLength={200} defaultValue={shop?.name ?? ""} className={inputClass} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={o.address}>
          <input name="address" maxLength={200} defaultValue={shop?.address ?? ""} className={inputClass} />
        </Field>
        <Field label={o.city}>
          <input name="city" required maxLength={100} defaultValue={shop?.city ?? ""} className={inputClass} />
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
        <Field label={dict.dashboard.phone}>
          <input name="phone" type="tel" maxLength={40} defaultValue={shop?.phone ?? ""} className={inputClass} />
        </Field>
        <Field label={o.ico}>
          <input name="ico" maxLength={40} defaultValue={shop?.ico ?? ""} className={inputClass} />
        </Field>
      </div>
      <Field label={dict.dashboard.website}>
        <input name="website" type="url" placeholder="https://" defaultValue={shop?.website ?? ""} className={inputClass} />
      </Field>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm">{o.location}</legend>
        <LocationPicker
          initial={{ lat: shop?.lat ?? null, lng: shop?.lng ?? null }}
          labels={{ lat: o.lat, lng: o.lng, hint: o.map_hint, map: o.location }}
        />
      </fieldset>

      <div className="flex flex-col gap-1">
        <span className="text-sm">{dict.dashboard.hours}</span>
        <HoursEditor
          name="opening_hours"
          initial={shop?.opening_hours ?? null}
          dayNames={Object.fromEntries(DAYS.map((d) => [d, dayName(d, lang)])) as Record<DayKey, string>}
          labels={{ closed: dict.dashboard.closed_day, add: dict.dashboard.add_range, remove: dict.dashboard.remove_range }}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm">{dict.dashboard.amenities_title}</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="has_toilet" defaultChecked={shop?.has_toilet ?? false} />
          {dict.shop.toilet}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="has_douchette" defaultChecked={shop?.has_douchette ?? false} />
          {dict.shop.douchette}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="has_card_terminal" defaultChecked={shop?.has_card_terminal ?? false} />
          {dict.shop.card_terminal}
        </label>
      </fieldset>
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" name="is_active" defaultChecked={shop?.is_active ?? true} />
        {o.active}
      </label>
      <button type="submit" className="self-start rounded border border-foreground px-4 py-2 font-medium">
        {submitLabel}
      </button>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}
