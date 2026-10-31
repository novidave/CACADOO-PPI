"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { approveInventory, disconnectInventory } from "@/app/[lang]/(account)/sync/inventoryApiActions";
import type { Dictionary } from "@/i18n/dictionaries";
import { functionFailure } from "@/lib/functionError";
import { createClient } from "@/lib/supabase/client";

/** owner_inventory_api() (database update 49): never the key, only its last 4 characters. */
export interface InventoryApiState {
  plan: "free" | "pro";
  allowed: boolean;
  interval_minutes: number;
  providers: { code: string; available: boolean; min_interval_minutes: number }[];
  connection: {
    provider: string;
    key_hint: string | null;
    settings: Record<string, string> | null;
    status: "preview" | "active" | "invalid_key" | "error";
    fields: string[] | null;
    sample_rows: Record<string, unknown>[] | null;
    product_count: number | null;
    has_quantity: boolean | null;
    mapping: Record<string, string | null> | null;
    mapping_status: string | null;
    approved_at: string | null;
    last_result: { items?: number; changed?: number } | null;
    running: boolean;
    last_error_code: string | null;
    manual_left: number;
  } | null;
}

/** The connection's times, already written in the shop's time zone on the server. */
export interface InventoryApiDates {
  connected: string | null;
  keyChanged: string | null;
  lastSuccess: string | null;
  nextRun: string | null;
}

type Labels = Dictionary["inventory_api"];

/** The fields of each built adapter's form (the function checks them again: inventory-connect parse()). */
const FORMS: Record<string, { credentials: string[]; settings: string[] }> = {
  superfaktura: { credentials: ["email", "apikey", "company_id"], settings: ["country"] },
  woocommerce: { credentials: ["consumer_key", "consumer_secret"], settings: ["store_url"] },
  custom: { credentials: ["url", "header_name", "header_value"], settings: ["format", "items_path"] },
};
const SECRET = new Set(["apikey", "consumer_secret", "header_value"]);
const OPTIONAL = new Set(["company_id", "header_name", "header_value", "items_path"]);
const CHOICES: Record<string, string[]> = { country: ["sk", "cz", "at", "sandbox"], format: ["auto", "json", "csv"] };
const MAPPING_FIELDS = ["source_code", "name", "ean", "brand", "quantity", "price", "currency", "description", "category"];
const REQUIRED = new Set(["source_code", "name", "price", "quantity"]);

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/**
 * "Pripojiť skladový program (API)": the programs (built ones can be connected, the others say "Pripravujeme"), the
 * form with where to make a read-only key, the preview with the fields to approve ("Schváliť a spustiť"), and the
 * connection's card (last sync, next sync, the last error in words, "Synchronizovať teraz", "Otestovať pripojenie",
 * "Zmeniť kľúč", "Odpojiť"). The key goes from this browser straight to the inventory-connect function with the
 * owner's login and is never shown again; everything is checked again there and in SQL.
 */
export function InventoryConnect({
  shopId,
  state,
  dates,
  planHref,
  labels,
  fieldLabels,
}: {
  shopId: string;
  state: InventoryApiState;
  dates: InventoryApiDates;
  planHref: string;
  labels: Labels;
  fieldLabels: Record<string, string>;
}) {
  const router = useRouter();
  const l = labels as Record<string, string>;
  const conn = state.connection;
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(conn?.mapping ?? {}).filter((e): e is [string, string] => typeof e[1] === "string")),
  );
  const [withoutQuantity, setWithoutQuantity] = useState(false);

  const errorText = (code: string | null | undefined) => (code ? (l[`error_${code}`] ?? labels.error_failed) : labels.error_failed);
  const name = (code: string) => l[`name_${code}`] ?? code;
  const interval = (minutes: number) =>
    minutes >= 60 && minutes % 60 === 0 ? fill(labels.interval_hours, { hours: minutes / 60 }) : fill(labels.interval, { minutes });

  async function call(action: string, body: Record<string, unknown> = {}) {
    const { data, error } = await createClient().functions.invoke<Record<string, unknown>>("inventory-connect", {
      body: { action, shop_id: shopId, ...body },
      method: "POST",
    });
    if (!error) return data ?? {};
    const failure = await functionFailure(error);
    return { error: failure.error ?? (failure.platform ? "config" : "failed") };
  }

  async function connect(provider: string, form: HTMLFormElement) {
    const data = new FormData(form);
    const pick = (keys: string[]) =>
      Object.fromEntries(keys.map((k) => [k, String(data.get(k) ?? "").trim()]).filter(([, v]) => v !== ""));
    setBusy("connect");
    setMessage(null);
    try {
      const answer = await call("connect", { provider, credentials: pick(FORMS[provider].credentials), settings: pick(FORMS[provider].settings) });
      if (answer.error && !answer.connected) {
        setMessage(errorText(String(answer.error)));
        return;
      }
      form.reset(); // the key does not stay in the page
      setOpen(null);
      if (answer.error) setMessage(errorText(String(answer.error)));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function simple(action: "test" | "preview" | "sync_now") {
    setBusy(action);
    setMessage(null);
    try {
      const answer = await call(action);
      if (answer.error) setMessage(errorText(String(answer.error)));
      else if (action === "test") setMessage(labels.test_ok);
      else if (action === "sync_now") setMessage(labels.sync_queued);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    setBusy("approve");
    setMessage(null);
    try {
      const result = await approveInventory({ shopId, mapping, withoutQuantity });
      setMessage(result.ok ? labels.approved : errorText(result.error));
      if (result.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!conn || !window.confirm(fill(labels.disconnect_confirm, { program: name(conn.provider) }))) return;
    setBusy("disconnect");
    try {
      const result = await disconnectInventory(shopId);
      setMessage(result.ok ? labels.disconnected : errorText(result.error));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const providerForm = (code: string, intro?: string) => (
    <form
      className="flex flex-col gap-3 border-t border-line pt-3"
      autoComplete="off"
      data-inventory-form={code}
      onSubmit={(e) => {
        e.preventDefault();
        void connect(code, e.currentTarget);
      }}
    >
      {intro && <p className="text-sm">{intro}</p>}
      <p className="text-sm text-muted">{l[`help_${code}`]}</p>
      {[...FORMS[code].credentials, ...FORMS[code].settings].map((field) => (
        <label key={field} className="flex flex-col gap-1 text-sm">
          <span>{l[`field_${field}`] ?? field}</span>
          {CHOICES[field] ? (
            <select name={field} defaultValue={CHOICES[field][0]} className="border border-line p-2">
              {CHOICES[field].map((choice) => (
                <option key={choice} value={choice}>
                  {l[`${field}_${choice}`] ?? choice}
                </option>
              ))}
            </select>
          ) : (
            <input
              name={field}
              type={SECRET.has(field) ? "password" : field === "email" ? "email" : "text"}
              required={!OPTIONAL.has(field)}
              autoComplete={SECRET.has(field) ? "new-password" : "off"}
              spellCheck={false}
              className="border border-line p-2"
            />
          )}
        </label>
      ))}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy !== null} className="border border-foreground px-4 py-2 font-medium disabled:opacity-50">
          {busy === "connect" ? labels.connecting : labels.connect}
        </button>
        <button type="button" onClick={() => setOpen(null)} className="px-2 py-2 underline underline-offset-4">
          {labels.cancel}
        </button>
      </div>
    </form>
  );

  const privacy = (
    <div className="flex flex-col gap-1 text-sm text-muted" data-inventory-privacy>
      <span className="font-medium text-foreground">{labels.privacy_title}</span>
      <p>{labels.privacy_text}</p>
    </div>
  );

  const notice = message && (
    <p className="text-sm font-semibold" role="status" data-inventory-message>
      {message}
    </p>
  );

  if (!conn) {
    return (
      <div className="flex flex-col gap-4" data-inventory-api="none">
        <p className="text-sm">{labels.intro}</p>
        {!state.allowed ? (
          <p className="text-sm">
            <span className="font-semibold">{labels.plan_pro}</span>{" "}
            <a href={planHref} className="underline underline-offset-4">
              {labels.plan_link}
            </a>
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              {interval(state.interval_minutes)}
              {state.plan === "free" ? ` ${fill(labels.free_interval, { hours: Math.round(state.interval_minutes / 60) })}` : ""}
            </p>
            <h3 className="font-semibold">{labels.choose}</h3>
            <ul className="flex flex-col gap-3">
              {state.providers.map((p) => (
                <li key={p.code} className="flex flex-col gap-2 border border-line p-3" data-provider={p.code} data-available={p.available}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{name(p.code)}</span>
                    {p.available && FORMS[p.code] ? (
                      open !== p.code && (
                        <button type="button" onClick={() => setOpen(p.code)} className="border border-foreground px-3 py-1 text-sm">
                          {labels.connect}
                        </button>
                      )
                    ) : (
                      <span className="text-sm font-semibold">{labels.coming}</span>
                    )}
                  </div>
                  {(!p.available || !FORMS[p.code]) && l[`help_${p.code}`] && <p className="text-sm text-muted">{l[`help_${p.code}`]}</p>}
                  {p.available && open === p.code && FORMS[p.code] && providerForm(p.code)}
                </li>
              ))}
            </ul>
          </>
        )}
        {notice}
        {privacy}
      </div>
    );
  }

  const fields = conn.fields ?? [];
  const rows = conn.sample_rows ?? [];
  const settings = conn.settings ?? {};
  const address = settings.host ?? settings.store_url ?? (settings.country ? l[`country_${settings.country}`] : null);
  const inPreview = conn.status === "preview";
  const missing = MAPPING_FIELDS.filter((f) => REQUIRED.has(f) && !(f === "quantity" && withoutQuantity) && !mapping[f]);
  const next = conn.running
    ? labels.running
    : conn.status === "invalid_key"
      ? labels.paused
      : inPreview
        ? labels.never
        : (dates.nextRun ?? labels.never);

  return (
    <div className="flex flex-col gap-4" data-inventory-api={conn.status}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted">{labels.program}</dt>
        <dd className="font-semibold" data-inventory-program>
          {name(conn.provider)}
        </dd>
        <dt className="text-muted">{labels.connected_since}</dt>
        <dd>{dates.connected ?? "–"}</dd>
        <dt className="text-muted">{labels.key}</dt>
        <dd data-inventory-key>{fill(labels.key_hint, { hint: conn.key_hint ?? "", date: dates.keyChanged ?? dates.connected ?? "" })}</dd>
        {address && (
          <>
            <dt className="text-muted">{labels.address}</dt>
            <dd className="break-all">{address}</dd>
          </>
        )}
        <dt className="text-muted">{labels.last_success}</dt>
        <dd data-inventory-last>
          {dates.lastSuccess
            ? `${dates.lastSuccess} · ${fill(labels.last_result, { n: conn.last_result?.items ?? 0, changes: conn.last_result?.changed ?? 0 })}`
            : labels.never}
        </dd>
        <dt className="text-muted">{labels.next_sync}</dt>
        <dd>{next}</dd>
        <dt className="text-muted">{labels.last_error}</dt>
        <dd className={conn.last_error_code ? "font-semibold" : ""} data-inventory-error={conn.last_error_code ?? ""}>
          {conn.last_error_code ? errorText(conn.last_error_code) : labels.no_error}
        </dd>
      </dl>

      {inPreview && (
        <section className="flex flex-col gap-3 border border-foreground p-3" data-inventory-preview>
          <h3 className="font-semibold">{labels.preview_title}</h3>
          {conn.approved_at || conn.last_error_code === "fields_changed" ? (
            <p className="text-sm font-semibold">{labels.preview_changed}</p>
          ) : null}
          {fields.length === 0 ? (
            <p className="text-sm">{labels.preview_empty}</p>
          ) : (
            <>
              <p className="text-sm">{fill(labels.preview_intro, { n: conn.product_count ?? rows.length })}</p>
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{labels.preview_rows}</span>
                <div className="overflow-x-auto">
                  <table className="min-w-full border-collapse text-xs">
                    <thead>
                      <tr>
                        {fields.map((f) => (
                          <th key={f} className="border border-line px-2 py-1 text-left font-medium">
                            {f}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={i}>
                          {fields.map((f) => (
                            <td key={f} className="border border-line px-2 py-1">
                              {cell(row[f])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium">{labels.mapping}</legend>
                {MAPPING_FIELDS.map((f) => (
                  <label key={f} className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[14rem_1fr] sm:items-center">
                    <span>
                      {fieldLabels[`col_${f}`] ?? f}
                      {REQUIRED.has(f) && !(f === "quantity" && withoutQuantity) ? ` (${labels.required})` : ""}
                    </span>
                    <select
                      value={mapping[f] ?? ""}
                      data-mapping={f}
                      onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value }))}
                      className="border border-line p-2"
                    >
                      <option value="">{labels.mapping_none}</option>
                      {fields.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </fieldset>
              {conn.has_quantity === false && (
                <div className="flex flex-col gap-1 text-sm" data-no-quantity>
                  <span className="font-semibold">{labels.no_quantity}</span>
                  <span>{labels.no_quantity_text}</span>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={withoutQuantity} onChange={(e) => setWithoutQuantity(e.target.checked)} className="mt-1" />
                    <span>{labels.no_quantity_agree}</span>
                  </label>
                </div>
              )}
              <button
                type="button"
                onClick={() => void approve()}
                disabled={busy !== null || missing.length > 0 || (conn.has_quantity === false && !withoutQuantity)}
                className="self-start border border-foreground px-4 py-2 font-semibold disabled:opacity-50"
                data-inventory-approve
              >
                {busy === "approve" ? labels.approving : labels.approve}
              </button>
            </>
          )}
          <button type="button" onClick={() => void simple("preview")} disabled={busy !== null} className="self-start text-sm underline underline-offset-4 disabled:opacity-50">
            {busy === "preview" ? labels.preview_loading : labels.preview_reload}
          </button>
        </section>
      )}

      {notice}

      <div className="flex flex-wrap items-center gap-3">
        {!inPreview && (
          <span className="flex flex-col">
            <button
              type="button"
              onClick={() => void simple("sync_now")}
              disabled={busy !== null || conn.status !== "active" || conn.manual_left <= 0 || conn.running}
              className="border border-foreground px-4 py-2 font-medium disabled:opacity-50"
              data-inventory-sync
            >
              {labels.sync_now}
            </button>
            <span className="text-xs text-muted">{conn.manual_left > 0 ? fill(labels.sync_left, { left: conn.manual_left }) : labels.sync_none_left}</span>
          </span>
        )}
        <button type="button" onClick={() => void simple("test")} disabled={busy !== null} className="border border-line px-4 py-2 disabled:opacity-50">
          {busy === "test" ? labels.testing : labels.test}
        </button>
        {FORMS[conn.provider] && (
          <button type="button" onClick={() => setOpen(open === "change" ? null : "change")} className="border border-line px-4 py-2">
            {labels.change_key}
          </button>
        )}
        <button type="button" onClick={() => void disconnect()} disabled={busy !== null} className="border border-line px-4 py-2 disabled:opacity-50" data-inventory-disconnect>
          {labels.disconnect}
        </button>
      </div>
      {open === "change" && FORMS[conn.provider] && providerForm(conn.provider, labels.change_key_intro)}
      {privacy}
    </div>
  );
}
