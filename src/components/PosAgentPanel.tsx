"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type ConnectorDevice,
  type ConnectorSnapshot,
  type ConnectorState,
  createPairingCode,
  decideSnapshot,
  loadDevices,
  loadSnapshots,
  renameDevice,
  revokeDevice,
} from "@/app/[lang]/(account)/sync/connectorActions";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";

type Labels = Dictionary["pos_agent"];

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

const REFRESH_MS = 30_000;

/**
 * "Prepojenie s pokladňou (POS agent)" (database update 50): pair a Cacaduu POS Sync Agent with a one-time code,
 * the paired devices with their state (worked out in SQL from the heartbeat times, refreshed every 30 s while the
 * page is open), rename and "Odpojiť". The code is shown once; nothing secret is kept in the page afterwards.
 * Update 52: the last stock snapshots the agents sent (used / checked only / refused with the reason), and for a held
 * one — empty or far smaller than the last — "Áno, použiť tento stav" or "Zahodiť".
 */
export function PosAgentPanel({
  shopId,
  initial,
  initialSnapshots = [],
  lang,
  timeZone,
  labels,
}: {
  shopId: string;
  initial: ConnectorState;
  initialSnapshots?: ConnectorSnapshot[];
  lang: Locale;
  timeZone: string | null;
  labels: Labels;
}) {
  const l = labels as Record<string, string>;
  const [state, setState] = useState<ConnectorState>(initial);
  const [snapshots, setSnapshots] = useState<ConnectorSnapshot[]>(initialSnapshots);
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const when = (iso: string | null) => (iso ? formatDateTime(iso, lang, timeZone) : labels.never);

  const refresh = useCallback(async () => {
    const [result, snaps] = await Promise.all([loadDevices(shopId), loadSnapshots(shopId)]);
    if (snaps.ok) setSnapshots(snaps.value);
    if (!result.ok) return;
    setState(result.value);
    // once a device paired after the code was made, the code has done its job
    setCode((c) => (c && result.value.devices.some((d) => Date.parse(d.paired_at) >= Date.parse(c.expires_at) - 10 * 60_000) ? null : c));
  }, [shopId]);

  // states change with every heartbeat (and when the agent stops): read them again while the page is open
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, code ? 5_000 : REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh, code]);

  async function addDevice() {
    setBusy("code");
    setMessage(null);
    try {
      const result = await createPairingCode(shopId);
      if (result.ok) setCode(result.value);
      else setMessage(l[`error_${result.error}`] ?? labels.error_failed);
    } finally {
      setBusy(null);
    }
  }

  async function rename(device: ConnectorDevice, form: HTMLFormElement) {
    const name = String(new FormData(form).get("name") ?? "");
    setBusy(device.id);
    try {
      const result = await renameDevice(device.id, name);
      if (result.ok) {
        setEditing(null);
        await refresh();
      } else setMessage(l[`error_${result.error}`] ?? labels.error_failed);
    } finally {
      setBusy(null);
    }
  }

  async function decide(snapshot: ConnectorSnapshot, use: boolean) {
    setBusy(snapshot.id);
    setMessage(null);
    try {
      const result = await decideSnapshot(shopId, snapshot.id, use);
      await refresh();
      setMessage(result.ok ? (use ? labels.held_used : labels.held_discarded) : (l[`error_${result.error}`] ?? labels.error_failed));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(device: ConnectorDevice) {
    if (!window.confirm(fill(labels.revoke_confirm, { name: device.name }))) return;
    setBusy(device.id);
    try {
      const result = await revokeDevice(device.id);
      await refresh();
      setMessage(result.ok ? fill(labels.revoked, { name: device.name }) : labels.error_failed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-pos-agent>
      <p className="text-sm">{labels.intro}</p>

      {code ? (
        <div className="flex flex-col gap-2 border border-foreground p-3" data-pairing-code>
          <span className="text-sm">{labels.code_title}</span>
          <span className="font-mono text-3xl font-semibold tracking-widest" data-code>
            {code.code}
          </span>
          <span className="text-sm text-muted">{fill(labels.code_valid_until, { time: when(code.expires_at) })}</span>
          <ol className="list-decimal pl-6 text-sm">
            <li>{labels.step_1}</li>
            <li>{labels.step_2}</li>
            <li>{labels.step_3}</li>
          </ol>
          <span className="text-sm text-muted">{labels.code_once}</span>
          <button type="button" onClick={() => setCode(null)} className="self-start text-sm underline underline-offset-4">
            {labels.code_hide}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void addDevice()}
          disabled={busy !== null}
          className="self-start border border-foreground px-4 py-2 font-medium disabled:opacity-50"
          data-add-device
        >
          {busy === "code" ? labels.working : labels.add}
        </button>
      )}

      {message && (
        <p className="text-sm font-semibold" role="status" data-pos-message>
          {message}
        </p>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="pos-devices-title">
        <h3 id="pos-devices-title" className="font-semibold">
          {labels.devices_title}
        </h3>
        {state.devices.length === 0 ? (
          <p className="text-sm">{labels.devices_none}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {state.devices.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 border border-line p-3 text-sm" data-device={d.id} data-state={d.state}>
                {editing === d.id ? (
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(d, e.currentTarget);
                    }}
                  >
                    <label className="flex flex-col gap-1">
                      <span>{labels.name}</span>
                      <input name="name" defaultValue={d.name} maxLength={80} required className="border border-line p-2" />
                    </label>
                    <button type="submit" disabled={busy !== null} className="border border-foreground px-3 py-2">
                      {labels.save}
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className="px-2 py-2 underline underline-offset-4">
                      {labels.cancel}
                    </button>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold">{d.name}</span>
                    <span className="font-semibold" data-device-state>
                      {d.state === "never_synced" ? `${labels.state_online} · ${labels.state_never_synced}` : (l[`state_${d.state}`] ?? d.state)}
                    </span>
                  </div>
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
                  <dt className="text-muted">{labels.last_seen}</dt>
                  <dd>{when(d.last_seen_at)}</dd>
                  <dt className="text-muted">{labels.last_sync}</dt>
                  <dd>{when(d.last_sync_at)}</dd>
                  <dt className="text-muted">{labels.agent}</dt>
                  <dd>{[d.agent_version, d.os].filter(Boolean).join(" · ") || "–"}</dd>
                  <dt className="text-muted">{labels.source}</dt>
                  <dd>{d.source_label || "–"}</dd>
                  <dt className="text-muted">{labels.paired}</dt>
                  <dd>{when(d.paired_at)}</dd>
                  {d.last_error && (
                    <>
                      <dt className="text-muted">{labels.last_error}</dt>
                      {/* plain text from the agent, never HTML */}
                      <dd className="break-words">{d.last_error}</dd>
                    </>
                  )}
                </dl>
                {editing !== d.id && (
                  <div className="flex flex-wrap gap-3">
                    <button type="button" onClick={() => setEditing(d.id)} className="border border-line px-3 py-2">
                      {labels.rename}
                    </button>
                    <button
                      type="button"
                      onClick={() => void revoke(d)}
                      disabled={busy !== null}
                      className="border border-line px-3 py-2 disabled:opacity-50"
                      data-revoke
                    >
                      {labels.revoke}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="pos-snapshots-title" data-pos-snapshots>
        <h3 id="pos-snapshots-title" className="font-semibold">
          {labels.snapshots_title}
        </h3>
        {snapshots.length === 0 ? (
          <p className="text-sm">{labels.snapshots_none}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {snapshots.map((snap) => (
              <li key={snap.id} className="flex flex-col gap-1 border border-line p-3 text-sm" data-snapshot={snap.id} data-snapshot-state={snap.state}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">{l[`snap_${snap.state}`] ?? snap.state}</span>
                  <span className="text-muted">{fill(labels.snap_time, { time: when(snap.source_time), device: snap.device ?? "–" })}</span>
                </div>
                <span>
                  {snap.state === "applied" && snap.result
                    ? fill(labels.snap_counts, {
                        products: snap.result.products ?? snap.product_count,
                        imported: snap.result.imported ?? 0,
                        zeroed: snap.result.zeroed ?? 0,
                        skipped: snap.result.skipped ?? 0,
                      })
                    : fill(labels.snap_products, { products: snap.product_count })}
                </span>
                {snap.state === "rejected" && snap.error && (
                  <span data-snapshot-reason>{l[`reason_${snap.error}`] ?? labels.reason_rejected}</span>
                )}
                {snap.result?.skipped_text && snap.state !== "rejected" && (
                  /* plain text: line numbers and field names only */
                  <span className="break-words text-muted">{fill(labels.skipped_note, { text: snap.result.skipped_text })}</span>
                )}
                {snap.state === "held" && (
                  <div className="flex flex-col gap-2 border border-foreground p-3" data-held>
                    <p className="font-semibold">
                      {snap.product_count === 0
                        ? labels.held_empty
                        : fill(labels.held_shrinking, { products: snap.product_count, previous: snap.previous_count ?? "–" })}
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => void decide(snap, true)}
                        disabled={busy !== null}
                        className="border border-foreground px-3 py-2 font-medium disabled:opacity-50"
                        data-held-use
                      >
                        {labels.held_use}
                      </button>
                      <button
                        type="button"
                        onClick={() => void decide(snap, false)}
                        disabled={busy !== null}
                        className="border border-line px-3 py-2 disabled:opacity-50"
                        data-held-discard
                      >
                        {labels.held_discard}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-col gap-1 text-sm text-muted">
        <span className="font-medium text-foreground">{labels.about_title}</span>
        <p>{labels.about_text}</p>
      </div>
    </div>
  );
}
