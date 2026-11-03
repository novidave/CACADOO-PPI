import "server-only";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth";
import { createPublicClient } from "@/lib/supabase/public";

/**
 * Zariadenia (database update 72): a phone paired to one shop's Sklad by a QR code. Its key (skt_ + 64 hex) lives only
 * in this HttpOnly cookie; the database keeps its hash. Every call of a phone goes through sklad_device_call (the one
 * door: its ticks, its own shop and name, 120 a minute, as the owner who paired it, no purchase prices in the answer).
 */

export const DEVICE_COOKIE = "ppi_skd";
const TOKEN = /^skt_[0-9a-f]{64}$/;
/** The cookie outlives the server's rule (90 days unused → refused there); the server decides, not the cookie. */
export const DEVICE_COOKIE_DAYS = 400;

export type DevicePerm = "sale" | "receive" | "counts" | "terminal";
export const DEVICE_PERMS: DevicePerm[] = ["sale", "receive", "counts", "terminal"];

export interface DeviceInfo {
  id: string;
  name: string;
  perms: DevicePerm[];
  shop: { id: string; slug: string; name: string; timezone: string };
  source: string;
  sale_source: string;
  receipt_location: string | null;
}

export interface RpcResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}
export type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<RpcResult>;

export async function deviceToken(): Promise<string | null> {
  const v = (await cookies()).get(DEVICE_COOKIE)?.value ?? "";
  return TOKEN.test(v) ? v : null;
}

/** The phone's door as an rpc: the same call shape as the owner's client, so the Sklad actions serve both. */
export async function deviceRpc(): Promise<Rpc | null> {
  const token = await deviceToken();
  const client = createPublicClient();
  if (!token || !client) return null;
  return async (fn, args = {}) => {
    const { data, error } = await client.rpc("sklad_device_call", { p_token: token, p_fn: fn, p_args: args });
    return { data, error: error ? { message: error.message, code: error.code } : null };
  };
}

/** The paired phone of this browser, or null (no key, disconnected, unused 90 days, its owner left the shop). */
export async function deviceWhoami(): Promise<DeviceInfo | null> {
  const token = await deviceToken();
  const client = createPublicClient();
  if (!token || !client) return null;
  const { data, error } = await client.rpc("sklad_device_whoami", { p_token: token });
  return error || !data ? null : (data as DeviceInfo);
}

/** The owner's login first (Môj obchod), else this browser's paired phone; null = neither. */
export async function skladRpc(): Promise<Rpc | null> {
  const session = await getSession();
  if (session) {
    return async (fn, args = {}) => {
      const { data, error } = await session.supabase.rpc(fn, args);
      return { data, error: error ? { message: error.message, code: error.code } : null };
    };
  }
  return await deviceRpc();
}
