import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { createClient } from "@/lib/supabase/server";
import { missingSupabaseEnv, supabaseEnv } from "@/lib/supabase/env";
import { formatDistance, formatPrice } from "@/lib/format";
import { resolveLocation, type VisitorLocation } from "@/lib/location";
import { availabilityText, freshnessText, type StockRow } from "@/lib/stock";
import { LocateButton } from "@/components/LocateButton";

const RADII = [2, 5, 10, 25, 50] as const;
const DEFAULT_RADIUS = 10;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function HomePage({ params, searchParams }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim();
  const radiusParam = Number(first(sp.radius));
  const radius = (RADII as readonly number[]).includes(radiusParam) ? radiusParam : DEFAULT_RADIUS;
  const onlyAvailable = first(sp.only) === "1";
  const location = resolveLocation({ lat: first(sp.lat), lng: first(sp.lng) }, await headers());

  let rows: StockRow[] = [];
  let error: string | null = null;

  try {
    const supabase = await createClient();
    if (!supabase) {
      error = `${dict.search.not_connected} (${missingSupabaseEnv().join(", ")})`;
    } else if (q) {
      const result = await supabase.rpc("search_stock", {
        q,
        lat: location?.lat ?? null,
        lng: location?.lng ?? null,
        radius_km: radius,
        only_available: onlyAvailable,
      });
      if (result.error) {
        // Name the (public) project address so setup mistakes are visible.
        error = `${result.error.message} · Supabase: ${supabaseEnv()?.url}`;
      }
      rows = (result.data ?? []) as StockRow[];
    }
  } catch (e) {
    // e.g. a mistyped Supabase URL: show it instead of a blank 500 page.
    error = `${dict.search.not_connected} (${e instanceof Error ? e.message : String(e)})`;
  }

  // Links keep the search and a device location, never an IP-based one.
  const searchUrl = (overrides: Record<string, string>) => {
    const query = new URLSearchParams({
      q,
      radius: String(radius),
      ...(onlyAvailable ? { only: "1" } : {}),
      ...(location?.source === "device" ? { lat: String(location.lat), lng: String(location.lng) } : {}),
      ...overrides,
    });
    return `/${lang}?${query}`;
  };
  const widerRadius = location ? RADII.find((r) => r > radius) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted">{dict.site.tagline}</p>

      <form method="get" className="flex flex-col gap-3" role="search">
        <div className="flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={dict.search.placeholder}
            aria-label={dict.search.placeholder}
            className="min-w-0 flex-1 rounded border border-line px-3 py-2 outline-none focus:border-foreground"
          />
          <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium">
            {dict.search.button}
          </button>
        </div>
        {location?.source === "device" && (
          <>
            <input type="hidden" name="lat" value={location.lat} />
            <input type="hidden" name="lng" value={location.lng} />
          </>
        )}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {location && (
            <label className="flex items-center gap-2">
              {dict.search.radius}
              <select name="radius" defaultValue={radius} className="rounded border border-line bg-white px-2 py-1">
                {RADII.map((r) => (
                  <option key={r} value={r}>
                    {r} km
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" name="only" value="1" defaultChecked={onlyAvailable} />
            {dict.search.only_available}
          </label>
        </div>
        <LocationLine location={location} dict={dict} />
      </form>

      {error && <p className="rounded border border-line p-3 text-sm">{error}</p>}

      {q && !error && (
        <section aria-label={dict.search.results}>
          {rows.length === 0 ? (
            <div className="flex flex-col gap-2">
              <p>{location ? dict.search.empty : dict.search.empty_everywhere}</p>
              {widerRadius && (
                <a href={searchUrl({ radius: String(widerRadius) })} className="underline underline-offset-4">
                  {t(dict.search.widen, { n: widerRadius })}
                </a>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {rows.map((row) => (
                <ResultRow key={row.item_id} row={row} lang={lang} dict={dict} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function LocationLine({ location, dict }: { location: VisitorLocation | null; dict: Dictionary }) {
  const text =
    location?.source === "device"
      ? dict.search.near_device
      : location?.source === "approximate"
        ? location.label
          ? t(dict.search.near_approx, { place: location.label })
          : dict.search.near_approx_unknown
        : dict.search.everywhere;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
      <span>{text}</span>
      {location?.source !== "device" && (
        <>
          <span aria-hidden>·</span>
          <LocateButton
            label={location ? dict.search.use_precise : dict.search.use_location}
            locatingLabel={dict.search.locating}
            failedLabel={dict.search.location_failed}
          />
        </>
      )}
    </p>
  );
}

function ResultRow({ row, lang, dict }: { row: StockRow; lang: Locale; dict: Dictionary }) {
  const availability = availabilityText(dict, row.availability, row.quantity);
  const freshness = freshnessText(
    dict,
    row.freshness_state,
    row.freshness_age_minutes,
    row.latest_file_time,
    row.shop_timezone,
  );
  const where = [row.shop_name, row.shop_city, row.distance_km !== null ? formatDistance(row.distance_km, lang) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{row.item_name}</span>
        <span className="whitespace-nowrap font-medium">{formatPrice(row.price, lang, row.currency)}</span>
      </div>
      <div className="text-sm text-muted">{where}</div>
      <div className="text-sm">
        {availability && <span className="font-semibold">{availability} · </span>}
        <span className={availability ? "text-muted" : ""}>{freshness}</span>
      </div>
    </li>
  );
}
