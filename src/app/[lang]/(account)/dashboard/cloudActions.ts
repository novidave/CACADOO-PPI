"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession, requestOrigin } from "@/lib/auth";

/**
 * "Cloudový priečinok" (database update 23): every action goes to the cloud-export Edge
 * Function with the owner's own login; the function checks membership and the plan, keeps
 * the tokens (encrypted) and talks to OneDrive / Dropbox. The website never sees a token.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The providers' own consent pages: nothing else is followed. */
const CONSENT = /^https:\/\/(login\.microsoftonline\.com|www\.dropbox\.com)\//;
/** The function's answers → the texts in dict.cloud (error_<code>). */
const CODES: Record<string, string> = {
  share_link: "share_link",
  folder: "bad_folder",
  not_folder: "folder",
  not_configured: "not_configured",
  no_plan: "no_plan",
  no_cloud: "no_cloud",
  expired: "expired",
  cloud: "cloud",
  period: "period",
};

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const at = formData.get("at") === "conversations" ? "conversations" : "cloud";
  const back = (query: Record<string, string>): never =>
    redirect(`/${lang}/dashboard?${new URLSearchParams({ shop: slug, ...query, at })}#${at}`);
  return { lang, session, shopId, slug, back };
}

/** Calls cloud-export; a refusal comes back as one of the codes above (or "other:<message>"). */
async function cloudCall<T>(session: Session, body: Record<string, unknown>): Promise<{ data: T | null; code: string | null }> {
  const { data, error } = await session.supabase.functions.invoke<T>("cloud-export", { body });
  if (!error) return { data: data ?? null, code: null };
  const context = (error as { context?: unknown }).context;
  const answer = context instanceof Response ? await context.json().catch(() => null) : null;
  const code = typeof answer?.error === "string" ? answer.error : "";
  return { data: null, code: CODES[code] ?? `other:${(code || error.message || "no answer").slice(0, 120)}` };
}

const errQuery = (code: string) => ({ err: `cloud_${code}` });

/** "Pripojiť OneDrive" / "Pripojiť Dropbox" / "Pripojiť znova": off to the provider's consent page. */
export async function connectCloud(formData: FormData) {
  const { lang, session, shopId, slug, back } = await start(formData);
  const provider = String(formData.get("provider") ?? "");
  if (!UUID.test(shopId) || (provider !== "onedrive" && provider !== "dropbox")) back(errQuery("failed"));
  const { data, code } = await cloudCall<{ url?: string }>(session, {
    action: "connect",
    shop_id: shopId,
    provider,
    folder: String(formData.get("folder") ?? "").trim().slice(0, 400),
    return_url: `${await requestOrigin()}/${lang}/dashboard?${new URLSearchParams({ shop: slug, at: "cloud" })}`,
  });
  const url = typeof data?.url === "string" && CONSENT.test(data.url) ? data.url : null;
  if (!url) back(errQuery(code ?? "failed"));
  redirect(url!);
}

/** The folder typed as a path (a share link is explained, never used). */
export async function setCloudFolder(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const { code } = await cloudCall(session, {
    action: "set_folder",
    shop_id: shopId,
    path: String(formData.get("folder") ?? "").trim().slice(0, 400),
  });
  back(code ? errQuery(code) : { ok: "cloud_folder" });
}

/** "Odpojiť": the tokens are deleted (Dropbox's is also revoked); files in the cloud stay. */
export async function disconnectCloud(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  if (formData.get("confirm") !== "on") back(errQuery("confirm"));
  const { code } = await cloudCall(session, { action: "disconnect", shop_id: shopId });
  back(code ? errQuery(code) : { ok: "cloud_disconnected" });
}

/** "Uložiť staršie konverzácie": the period's conversations not in the cloud yet. */
export async function backfillCloud(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const from = String(formData.get("from") ?? "");
  const to = String(formData.get("to") ?? "");
  if (!DAY.test(from) || !DAY.test(to) || from > to) back(errQuery("period"));
  const { data, code } = await cloudCall<{ count?: number }>(session, { action: "backfill", shop_id: shopId, from, to });
  back(code ? errQuery(code) : { ok: "cloud_backfill", n: String(Number(data?.count ?? 0)) });
}

/** "Uložiť znova" for one conversation (from the list or the conversation's own page). */
export async function retryCloudExport(formData: FormData) {
  const { lang, session, back } = await start(formData);
  const id = String(formData.get("conversation_id") ?? "");
  if (!UUID.test(id)) back(errQuery("failed"));
  const { code } = await cloudCall(session, { action: "retry", conversation_id: id });
  if (formData.get("from") === "detail") {
    redirect(`/${lang}/dashboard/conversations/${id}?${new URLSearchParams(code ? errQuery(code) : { ok: "cloud_retry" })}`);
  }
  back(code ? errQuery(code) : { ok: "cloud_retry" });
}

export type FolderList = { path: string; folders: string[] } | { error: string };

/** The folder picker (a client component) lists the subfolders of one folder. */
export async function browseCloudFolders(shopId: string, path: string): Promise<FolderList> {
  const session = await getSession();
  if (!session || !UUID.test(shopId)) return { error: "failed" };
  const { data, code } = await cloudCall<{ path: string; folders: string[] }>(session, {
    action: "folders",
    shop_id: shopId,
    path: String(path).slice(0, 400),
  });
  if (!data || code) return { error: code ?? "failed" };
  return { path: data.path, folders: (data.folders ?? []).map(String).slice(0, 500) };
}

/** A new folder inside the one shown in the picker. */
export async function createCloudFolder(shopId: string, path: string, name: string): Promise<{ path: string } | { error: string }> {
  const session = await getSession();
  if (!session || !UUID.test(shopId)) return { error: "failed" };
  const { data, code } = await cloudCall<{ path: string }>(session, {
    action: "create_folder",
    shop_id: shopId,
    path: String(path).slice(0, 400),
    name: String(name).trim().slice(0, 120),
  });
  if (!data || code) return { error: code ?? "failed" };
  return { path: data.path };
}
