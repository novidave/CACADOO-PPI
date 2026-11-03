import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { deviceRpc, deviceWhoami, type DeviceInfo, type DevicePerm, type Rpc } from "@/lib/skladDevice";

/**
 * A paired phone's pages (database update 72): the phone's own name, shop and ticks come only from SQL
 * (sklad_device_whoami); every call goes through the phone's door (deviceRpc). No owner login is involved.
 */
export async function loadDevice(langValue: string) {
  if (!isLocale(langValue)) notFound();
  const lang: Locale = langValue;
  const dict = await getDictionary(lang);
  const [device, rpc] = await Promise.all([deviceWhoami(), deviceRpc()]);
  return { lang, dict, s: dict.sklad, d: dict.device, device, rpc };
}

export const can = (device: DeviceInfo | null, perm: DevicePerm) => !!device && device.perms.includes(perm);

/** The phone without a (working) pairing: what to do. */
export function NotPaired({ lang, d }: { lang: Locale; d: Dictionary["device"] }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4" data-device-unpaired>
      <h1 className="text-2xl font-bold">{d.unpaired_title}</h1>
      <p>{d.unpaired_text}</p>
      <Link href={`/${lang}/login`} className="self-start text-sm font-semibold underline underline-offset-4">
        {d.unpaired_owner}
      </Link>
    </div>
  );
}

/** The shop and the phone's name on top, a way back to the phone's start. */
export function DeviceShell({ lang, d, device, children, home = false }: { lang: Locale; d: Dictionary["device"]; device: DeviceInfo; children: ReactNode; home?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4" data-device={device.id}>
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex flex-col">
          <strong className="text-[15px]">{device.shop.name}</strong>
          <span className="text-[13px] text-muted">{device.name}</span>
        </div>
        {!home && (
          <Link href={`/${lang}/zariadenie`} className="flex min-h-11 items-center text-sm font-semibold underline underline-offset-4">
            {d.home}
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

export type { Rpc };
