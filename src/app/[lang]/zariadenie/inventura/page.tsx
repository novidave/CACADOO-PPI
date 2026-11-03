import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { can, DeviceShell, loadDevice, NotPaired } from "../device";

export async function generateMetadata({ params }: PageProps<"/[lang]/zariadenie/inventura">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).device.tile_counts };
}

/** Inventúra on a paired phone (database update 72): the open counts the owner started; the phone only counts. */
export default async function DeviceCounts({ params }: PageProps<"/[lang]/zariadenie/inventura">) {
  const { lang } = await params;
  const { s, d, device, rpc, lang: l } = await loadDevice(lang);
  if (!device || !rpc) return <NotPaired lang={l} d={d} />;
  if (!can(device, "counts")) notFound();
  const { data } = await rpc("owner_sklad_counts", { p_limit: 30 });
  const open = (((data ?? {}) as { rows?: { id: string; number: string; name: string | null; status: string; location: string | null; shelf: string | null }[] }).rows ?? []).filter(
    (c) => c.status === "open",
  );
  return (
    <DeviceShell lang={l} d={d} device={device}>
      <h1 className="text-2xl font-bold">{d.tile_counts}</h1>
      {open.length === 0 ? (
        <p className="text-sm text-muted">{d.counts_none}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {open.map((c) => (
            <li key={c.id}>
              <Link href={`/${l}/zariadenie/inventura/${c.id}`} className="flex min-h-16 flex-col justify-center rounded-xl border border-foreground px-4" data-device-count={c.id}>
                <strong>
                  {c.number}
                  {c.name ? ` · ${c.name}` : ""}
                </strong>
                <span className="text-[13px] text-muted">{[c.location, c.shelf ? `${s.ic_shelf} ${c.shelf}` : null].filter(Boolean).join(" · ")}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DeviceShell>
  );
}
