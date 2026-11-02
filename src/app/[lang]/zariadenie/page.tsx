import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { forgetDevice } from "./actions";
import { DeviceShell, loadDevice, NotPaired } from "./device";

export async function generateMetadata({ params }: PageProps<"/[lang]/zariadenie">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).device.title };
}

const TILES = [
  { perm: "sale", path: "/predaj" },
  { perm: "receive", path: "/prijem" },
  { perm: "counts", path: "/inventura" },
  { perm: "terminal", path: "/terminal" },
] as const;

/** A paired phone's start (database update 72): only the screens its owner ticked, and "Odpojiť toto zariadenie". */
export default async function DeviceHome({ params, searchParams }: PageProps<"/[lang]/zariadenie">) {
  const { lang } = await params;
  const sp = await searchParams;
  const { d, device, lang: l } = await loadDevice(lang);
  const ok = typeof sp.ok === "string" ? sp.ok : "";
  if (!device) {
    return (
      <>
        {ok === "forgotten" && (
          <p role="status" className="mx-auto mb-4 w-full max-w-md rounded-xl border border-foreground p-3 font-medium">
            {d.ok_forgotten}
          </p>
        )}
        <NotPaired lang={l} d={d} />
      </>
    );
  }
  const texts = d as Record<string, string>;
  return (
    <DeviceShell lang={l} d={d} device={device} home>
      {ok === "paired" && (
        <p role="status" className="rounded-xl border border-foreground p-3 font-medium">
          {d.ok_paired}
        </p>
      )}
      <h1 className="text-2xl font-bold">{d.title}</h1>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TILES.filter((t) => device.perms.includes(t.perm)).map((t) => (
          <Link
            key={t.perm}
            href={`/${l}/zariadenie${t.path}`}
            className="flex min-h-20 flex-col justify-center gap-0.5 rounded-xl border border-foreground p-4"
            data-device-tile={t.perm}
          >
            <strong className="text-lg">{texts[`tile_${t.perm}`]}</strong>
            <span className="text-[13px] text-muted">{texts[`tile_${t.perm}_hint`]}</span>
          </Link>
        ))}
      </div>
      <p className="text-[13px] text-muted">{d.private}</p>
      <form action={forgetDevice}>
        <input type="hidden" name="lang" value={l} />
        <button type="submit" className="min-h-11 text-sm font-semibold underline underline-offset-4" data-device-forget>
          {d.forget}
        </button>
      </form>
    </DeviceShell>
  );
}
