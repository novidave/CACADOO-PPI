"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addDevice, deviceCode, type DevicePairing } from "@/app/[lang]/(account)/dashboard/sklad/actions";
import type { Locale } from "@/i18n/config";

export type DevicePairLabels = Record<string, string>;
const PERMS = ["sale", "receive", "counts", "terminal"] as const;

/**
 * Sklad → Nastavenia → Zariadenia (database update 72): "Pripojiť telefón (QR kód)" — a name and the ticks — or "Nový
 * kód" for a phone already listed. The code comes back once from the server as a QR code (the address carries it after
 * "#", so it never reaches a server log); it works once, for 10 minutes. "Hotovo" reads the list again.
 */
export function SkladDevicePair({
  lang,
  shopId,
  deviceId,
  labels: L,
}: {
  lang: Locale;
  shopId: string;
  /** set = "Nový kód" for this phone; empty = a new phone */
  deviceId?: string;
  labels: DevicePairLabels;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<string[]>(["sale"]);
  const [result, setResult] = useState<DevicePairing | null>(null);
  const [busy, start] = useTransition();

  const go = () =>
    start(async () => {
      const res = deviceId ? await deviceCode({ lang, shopId, id: deviceId }) : await addDevice({ lang, shopId, name, perms });
      setResult(res);
    });
  const done = () => {
    setResult(null);
    setOpen(false);
    setName("");
    router.refresh();
  };

  if (result?.ok && result.svg) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-foreground p-4 text-center" data-sklad-device-qr>
        <strong className="text-lg">{L.dv_qr_title}</strong>
        <div role="img" aria-label={L.dv_qr_alt} className="w-full max-w-[260px] [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: result.svg }} />
        <span className="text-sm">{L.dv_qr_hint}</span>
        <span className="text-[13px] text-muted">{L.dv_qr_once}</span>
        <details className="w-full text-left text-[13px]">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold underline underline-offset-4">{L.dv_qr_link}</summary>
          <input readOnly value={result.url} onFocus={(e) => e.currentTarget.select()} className="min-h-11 w-full rounded-xl border border-[#D6D6D6] px-3 font-mono text-[12px]" />
          <span className="text-muted">{L.dv_qr_link_hint}</span>
        </details>
        <button type="button" onClick={done} className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-foreground px-4 font-bold text-white">
          {L.dv_qr_done}
        </button>
      </div>
    );
  }

  if (deviceId) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" onClick={go} disabled={busy} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#D6D6D6] px-3 text-sm font-bold">
          {busy ? L.dv_making : L.dv_new_code}
        </button>
        <span className="text-[12px] text-muted">{L.dv_new_code_hint}</span>
        {result && !result.ok && (
          <span role="alert" className="text-sm">
            {L[`err_${result.error}`] ?? L.err_failed}
          </span>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-12 items-center justify-center self-start rounded-xl border border-[#D6D6D6] px-4 font-bold" data-sklad-device-add>
        {L.dv_add}
      </button>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <label className="flex flex-col gap-1 text-[15px]">
        <strong>{L.dv_name}</strong>
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder={L.dv_name_ph} className="min-h-11 rounded-xl border border-[#D6D6D6] px-3 text-[16px]" />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-[15px] font-bold">{L.dv_may}</legend>
        {PERMS.map((x) => (
          <label key={x} className="flex min-h-11 items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={perms.includes(x)}
              onChange={(e) => setPerms((p) => (e.target.checked ? [...p, x] : p.filter((y) => y !== x)))}
              className="mt-0.5 size-5 flex-none accent-foreground"
            />
            <span className="flex flex-col">
              <strong>{L[`dv_perm_${x}`]}</strong>
              <span className="text-[13px] text-muted">{L[`dv_perm_${x}_hint`]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {result && !result.ok && (
        <span role="alert" className="text-sm">
          {L[`err_${result.error}`] ?? L.err_failed}
        </span>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setOpen(false)} className="min-h-12 rounded-xl border border-[#D6D6D6] font-bold">
          {L.dv_close}
        </button>
        <button type="submit" disabled={busy || !name.trim() || perms.length === 0} className="min-h-12 rounded-xl bg-foreground font-bold text-white disabled:opacity-50">
          {busy ? L.dv_making : L.dv_make_qr}
        </button>
      </div>
    </form>
  );
}
