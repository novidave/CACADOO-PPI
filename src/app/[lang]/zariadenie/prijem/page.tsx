import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import type { SkladRow } from "@/lib/sklad";
import { receiveStock } from "../actions";
import { can, DeviceShell, loadDevice, NotPaired } from "../device";

export async function generateMetadata({ params }: PageProps<"/[lang]/zariadenie/prijem">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).device.tile_receive };
}

const input = "min-h-12 rounded-xl border border-[#D6D6D6] px-3 text-[16px] outline-none focus:border-foreground";

/**
 * "Príjem tovaru" on a paired phone (database update 72): find a product by its name, code or EAN (a USB scanner types
 * into the search field), type the pieces, "Prijať" — one Príjem movement into the shop's receiving place, under the
 * phone's name. Never a purchase price: the owner adds prices on the computer.
 */
export default async function DeviceReceive({ params, searchParams }: PageProps<"/[lang]/zariadenie/prijem">) {
  const { lang } = await params;
  const sp = await searchParams;
  const { s, d, device, rpc, lang: l } = await loadDevice(lang);
  if (!device || !rpc) return <NotPaired lang={l} d={d} />;
  if (!can(device, "receive")) notFound();
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 80);
  const rows = q ? (((await rpc("owner_sklad_products", { p_q: q, p_filter: "all", p_limit: 10, p_offset: 0 })).data as { rows: SkladRow[] } | null)?.rows ?? []) : [];
  const ok = typeof sp.ok === "string" ? sp.ok : "";
  const err = typeof sp.err === "string" ? sp.err : "";
  const texts = s as Record<string, string>;
  return (
    <DeviceShell lang={l} d={d} device={device}>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{d.tile_receive}</h1>
        <span className="text-sm text-muted">{d.receive_where.replace("{place}", device.receipt_location ?? "–")}</span>
      </div>
      {ok === "received" && (
        <p role="status" className="rounded-xl border border-foreground p-3 font-medium" data-device-received>
          {d.received.replace("{n}", String(sp.n ?? "")).replace("{name}", String(sp.name ?? ""))}
        </p>
      )}
      {err && (
        <p role="alert" className="rounded-xl border border-foreground p-3 font-medium">
          {texts[`err_${err}`] ?? (d as Record<string, string>)[`err_${err}`] ?? s.err_failed}
        </p>
      )}
      <form method="get" className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          autoFocus
          data-scan-ok
          placeholder={d.receive_search}
          aria-label={d.receive_search}
          className={`${input} min-w-0 flex-1`}
        />
        <button type="submit" className="inline-flex min-h-12 items-center rounded-xl border border-[#D6D6D6] px-4 font-bold">
          {d.search}
        </button>
      </form>
      {q && rows.length === 0 && <p className="text-sm text-muted">{d.receive_none}</p>}
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 rounded-xl border border-line p-3" data-device-product={r.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <strong className="text-[15px]">{r.name}</strong>
              <span className="text-[13px] text-muted">{[r.code, r.ean].filter(Boolean).join(" · ")}</span>
            </div>
            <span className="text-[13px]">{d.receive_now.replace("{n}", String(Number(r.total)))}</span>
            <form action={receiveStock} className="flex gap-2">
              <input type="hidden" name="lang" value={l} />
              <input type="hidden" name="item_id" value={r.id} />
              <input type="hidden" name="item_name" value={r.name} />
              <input type="hidden" name="shop_slug" value={device.shop.slug} />
              <input type="hidden" name="mid" value={randomUUID()} />
              <input name="qty" type="number" inputMode="decimal" min="0.001" step="any" defaultValue="1" required aria-label={d.receive_qty} className={`${input} w-28`} />
              <button type="submit" className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-foreground px-4 font-bold text-white">
                {d.receive_button}
              </button>
            </form>
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-muted">{d.receive_private}</p>
    </DeviceShell>
  );
}
