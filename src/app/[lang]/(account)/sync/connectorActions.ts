"use server";

import { getSession } from "@/lib/auth";
import { refreshShop } from "@/lib/publicCache";

/**
 * "Prepojenie s pokladňou (POS agent)" (database update 50) and its stock snapshots + "Zdroj zásob" (update 52),
 * called from the owner's browser. Every write goes
 * through an owner_connector_* function (membership checked there). No service role is needed: pairing itself, the
 * device tokens and heartbeats are the connector Edge Function's job.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConnectorDevice {
  id: string;
  name: string;
  agent_version: string | null;
  os: string | null;
  source_label: string | null;
  last_read_result: string | null;
  last_error: string | null;
  paired_at: string;
  last_seen_at: string | null;
  last_sync_at: string | null;
  state: "online" | "offline" | "error" | "never_synced" | "syncing";
}

export interface ConnectorState {
  devices: ConnectorDevice[];
  open_code_until: string | null;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function owner() {
  const s = await getSession();
  return s?.supabase ?? null;
}

/** "Pridať POS agenta": a new one-time code (shown once). */
export async function createPairingCode(shopId: string): Promise<Result<{ code: string; expires_at: string }>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { data, error } = await supabase.rpc("owner_connector_create_code", { p_shop_id: shopId });
  if (error) return { ok: false, error: error.message === "too_many" ? "too_many" : "failed" };
  return { ok: true, value: data as { code: string; expires_at: string } };
}

/** The devices again (the dashboard refreshes them while it is open). */
export async function loadDevices(shopId: string): Promise<Result<ConnectorState>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { data, error } = await supabase.rpc("owner_connector_devices", { p_shop_id: shopId });
  if (error) return { ok: false, error: "failed" };
  return { ok: true, value: data as ConnectorState };
}

export async function renameDevice(deviceId: string, name: string): Promise<Result<null>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(deviceId)) return { ok: false, error: "login" };
  const { error } = await supabase.rpc("owner_connector_rename", { p_device_id: deviceId, p_name: String(name ?? "").slice(0, 200) });
  if (error) return { ok: false, error: error.message === "name" ? "name" : "failed" };
  return { ok: true, value: null };
}

/** "Odpojiť": the device's token stops working at once. */
export async function revokeDevice(deviceId: string): Promise<Result<null>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(deviceId)) return { ok: false, error: "login" };
  const { error } = await supabase.rpc("owner_connector_revoke", { p_device_id: deviceId });
  if (error) return { ok: false, error: "failed" };
  return { ok: true, value: null };
}

/** One stock snapshot the POS agent sent (update 52), as owner_connector_snapshots() lists it. */
export interface ConnectorSnapshot {
  id: string;
  device: string | null;
  state: "awaiting_upload" | "processing" | "applied" | "held" | "test_ok" | "rejected" | "discarded";
  error: string | null;
  message: string | null;
  source_time: string;
  created_at: string;
  completed_at: string | null;
  decided_at: string | null;
  product_count: number;
  previous_count: number | null;
  result: { products?: number; imported?: number; zeroed?: number; skipped?: number; skipped_text?: string } | null;
  preview: { source_code: string; name: string; price: number; currency: string; quantity: number }[];
}

/** "Zdroj zásob": what changes the stock now ('api' while an inventory program is connected). */
export interface StockSource {
  active: "file" | "agent" | "api";
  chosen: "file" | "agent";
  api_provider: string | null;
  devices: number;
}

/** The last 10 snapshots (refreshed with the devices). */
export async function loadSnapshots(shopId: string): Promise<Result<ConnectorSnapshot[]>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { data, error } = await supabase.rpc("owner_connector_snapshots", { p_shop_id: shopId });
  if (error) return { ok: false, error: "failed" };
  return { ok: true, value: (data as ConnectorSnapshot[] | null) ?? [] };
}

async function refreshPage(supabase: NonNullable<Awaited<ReturnType<typeof owner>>>, shopId: string) {
  const { data } = await supabase.from("shops").select("slug").eq("id", shopId).maybeSingle();
  refreshShop((data as { slug?: string } | null)?.slug);
}

/** "Áno, použiť tento stav" (use = true) or "Zahodiť" for a held snapshot. */
export async function decideSnapshot(shopId: string, snapshotId: string, use: boolean): Promise<Result<{ state: string }>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId) || !UUID.test(snapshotId)) return { ok: false, error: "login" };
  const { data, error } = await supabase.rpc("owner_connector_decide", { p_shop_id: shopId, p_snapshot_id: snapshotId, p_use: use === true });
  if (error) return { ok: false, error: ["not_agent", "not_held"].includes(error.message) ? error.message : "failed" };
  const out = data as { state: string; error?: string };
  if (out.state === "rejected") return { ok: false, error: out.error === "stale" ? "stale" : "failed" };
  if (out.state === "applied") await refreshPage(supabase, shopId);
  return { ok: true, value: { state: out.state } };
}

export async function loadStockSource(shopId: string): Promise<Result<StockSource>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId)) return { ok: false, error: "login" };
  const { data, error } = await supabase.rpc("owner_stock_source", { p_shop_id: shopId });
  if (error) return { ok: false, error: "failed" };
  return { ok: true, value: data as StockSource };
}

/** "Zdroj zásob": files (folder / upload) or the POS agent. */
export async function setStockSource(shopId: string, source: string): Promise<Result<StockSource>> {
  const supabase = await owner();
  if (!supabase || !UUID.test(shopId) || (source !== "file" && source !== "agent")) return { ok: false, error: "login" };
  const { error } = await supabase.rpc("owner_set_stock_source", { p_shop_id: shopId, p_source: source });
  if (error) return { ok: false, error: ["api_connected", "no_device"].includes(error.message) ? error.message : "failed" };
  return loadStockSource(shopId);
}
