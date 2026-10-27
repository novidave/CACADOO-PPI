"use server";

import { getSession } from "@/lib/auth";

/**
 * "Prepojenie s pokladňou (POS agent)" (database update 50), called from the owner's browser. Every write goes
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
