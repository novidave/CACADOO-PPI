/// <reference lib="deno.ns" />
// PPI · shop-blog Edge Function
//
// The shop's blog ("Novinky", database update 37) and its Facebook Page. One file, pasted into the Supabase editor
// with "Verify JWT" OFF: it checks every caller itself.
//
//   Anyone:            POST {action: "config"} → {facebook}   (false: no Facebook buttons on the website)
//   The shop's owners (their login; membership checked by the database):
//     photo_begin   {post_id}                        → {photo_id}   a new photo of a Cacaduu post (at most 10)
//     POST ?action=photo&photo_id=…&size=1600|800      body: the picture, drawn in the owner's browser
//                   (WebP, or JPEG where the browser cannot write WebP; at most 1600 / 800 px wide, 5 MB)
//     photo_delete  {photo_id}     post_delete {post_id}   the files first, then the rows
//     publish_fb    {post_id, retry?}                → {ok, permalink} | {ok: false, error}   "Áno, zverejniť…" /
//                   "Skúsiť znova na Facebook": the post's text + up to 10 photos + "Čítať na webe: <address>"
//     connect       {shop_id, return_url}            → {url}   Facebook Login for Business
//     pages         {pending_id}                     → {pages: [{id, name, picture}]}   the owner picks one
//     pick          {pending_id, page_id}            → {page_name}
//     disconnect    {shop_id}                        "Odpojiť": the token is deleted; imported posts stay
//     import        {shop_id}                        "Stiahnuť všetky príspevky": all past posts, page by page
//   The admin: admin_info → the addresses and the webhook's verify token for the Meta app's settings.
//   Facebook:  GET …/shop-blog/oauth?code=&state=     (the login's way back) → the owner picks the Page
//              GET/POST …/shop-blog/webhook           Page feed changes (signed with the app secret) → a sync soon
//   Itself (Authorization: Bearer <service role key>): work {kind: "import", shop_id} | {kind: "photo", photo_id?}
//   The job (pg_cron every 5 minutes, header x-ppi-cron): tick — scheduled Facebook copies, imports that broke off,
//              the daily sync (new, edited, deleted → hidden), photos from Facebook (WebP 1600 / 800), IndexNow for
//              posts, the e-mail when the connection expired, unused files.
//
// Never: comments, reactions or other people's names (never asked from Facebook); a token, a key or a post's text in
// the logs. Shop texts are kept exactly as written. The Page token is kept only encrypted (AES-GCM,
// FB_TOKEN_ENCRYPTION_KEY). Without FACEBOOK_APP_ID / FACEBOOK_APP_SECRET everything Facebook is off ("config").
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "shop-blog" → paste this file →
// Deploy, then switch OFF "Verify JWT". Secrets: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FB_TOKEN_ENCRYPTION_KEY
// (32+ characters), optional FACEBOOK_CONFIG_ID (the Facebook Login for Business configuration); already set:
// SITE_URL, INDEXNOW_KEY, BREVO_API_KEY, ALERT_EMAIL_FROM.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import decodeJpeg, { init as initJpegDecode } from "npm:@jsquash/jpeg@1.6.0/decode.js";
import decodeWebp, { init as initWebpDecode } from "npm:@jsquash/webp@1.5.0/decode.js";
import encodeWebp, { init as initWebpEncode } from "npm:@jsquash/webp@1.5.0/encode.js";

export const BUCKET = "blog-photos";
/** Meta's Graph API version (each lives about two years; move on when Meta announces its end). */
export const GRAPH_VERSION = "v23.0";
/** Only what the blog needs: the Pages the owner runs, their posts, and posting as the Page. */
export const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
/** A post's own content: never comments, reactions, likes, tags, places or who wrote what. */
export const POST_FIELDS =
  "id,message,created_time,updated_time,permalink_url,is_published," +
  "attachments{type,media_type,url,unshimmed_url,title,description,target{id,url},media{image{src,width,height}}," +
  "subattachments.limit(100){type,media_type,url,unshimmed_url,title,target{id,url},media{image{src,width,height}}}}";
export const PAGE_SIZE = 25;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const SIZES = [1600, 800] as const;
export const MAX_FB_PHOTOS = 10;
export const TITLE_MAX = 70;
export const READ_ON_WEB = "Čítať na webe:";
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const LANGS = ["sk", "hu", "en"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FB_POST_ID = /^[0-9]{1,40}(_[0-9]{1,40})?$/;
const FB_ID = /^[0-9]{1,40}$/;
const PERMALINK = /^https:\/\/([a-z0-9-]+\.)?facebook\.com\//;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
/** Where Facebook keeps pictures, and YouTube's video pictures (update 39): nothing else is downloaded. */
export const MEDIA_HOSTS = [".fbcdn.net", ".fbsbx.com", ".facebook.com", "i.ytimg.com"];
const TICK_BUDGET_MS = 90_000;

// ---------------------------------------------------------------- small helpers

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  const b = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

export async function hmacHex(secret: string, text: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = typeof text === "string" ? enc.encode(text) : text;
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, data as BufferSource)));
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Equal strings, compared in constant time. */
export function sameSecret(given: string | null, expected: string | null): boolean {
  if (!given || !expected || expected.length < 20) return false;
  const a = enc.encode(given);
  const b = enc.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

type Json = Record<string, unknown>;

/**
 * Môj obchod calls this function straight from the owner's browser (photos, publishing), another origin than the
 * Supabase project: every answer carries the CORS headers and the browser's OPTIONS check is answered first, as in
 * page-sections and doc-ingest. Without them the browser blocks the call ("Failed to send a request to the Edge
 * Function"). The owner's login is still checked on every action.
 */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

function reply(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

const failText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/[\r\n]+/g, " ").slice(0, 300);

/** The shop's language on its own domain (the same rule as the SQL shop_site_lang()). */
export function siteLang(country: string | null | undefined): "sk" | "hu" | "en" {
  const c = String(country ?? "").toUpperCase();
  return c === "SK" ? "sk" : c === "HU" ? "hu" : "en";
}

// ---------------------------------------------------------------- the Page token, encrypted

/** AES-GCM key from FB_TOKEN_ENCRYPTION_KEY (any 32+ characters; HKDF-SHA-256). */
export async function tokenKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("FB_TOKEN_ENCRYPTION_KEY must have at least 32 characters");
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("ppi-shop-blog"), info: enc.encode("facebook tokens v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** "v1.<iv>.<ciphertext>"; `bind` ties it to its shop and Page (the same text elsewhere does not open). */
export async function encryptToken(key: CryptoKey, plain: string, bind: string): Promise<string> {
  const iv = random(12);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(bind) }, key, enc.encode(plain));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(data))}`;
}

export async function decryptToken(key: CryptoKey, text: string, bind: string): Promise<string> {
  const [version, iv, data] = text.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("unknown token format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(iv) as BufferSource, additionalData: enc.encode(bind) },
    key,
    fromB64url(data) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

const pageBind = (shopId: string, pageId: string) => `${shopId}:${pageId}:page`;
const pendingBind = (pendingId: string) => `${pendingId}:pages`;

// ---------------------------------------------------------------- texts: titles, the Facebook message, addresses

/**
 * An imported post's title: its first sentence (or line; an abbreviation like "č." does not end it), at most 70
 * characters, cut at a word ("…"); without
 * text, a shared link's title; else "Facebook · d. m. yyyy". The owner can change it.
 */
export function importTitle(message: string, linkTitle: string | null, created: string | null): string {
  const text = message.replace(/\s+$/g, "");
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  // A sentence ends at ! ? … before a space, at "." only before a capital letter (abbreviations: "Novinka č. 10 z
  // predajne. Príďte!" → "Novinka č. 10 z predajne."), or at the end of the line.
  const sentence = (/^(.+?(?:[!?…](?=\s)|\.(?=\s+["„“(]?\p{Lu})|[.!?…]?$))/u.exec(firstLine)?.[1] ?? firstLine).trim();
  const base = sentence || (linkTitle ?? "").trim();
  if (!base) {
    const d = created ? new Date(created) : null;
    return d && !Number.isNaN(d.getTime()) ? `Facebook · ${d.getUTCDate()}. ${d.getUTCMonth() + 1}. ${d.getUTCFullYear()}` : "Facebook";
  }
  const chars = [...base];
  if (chars.length <= TITLE_MAX) return base;
  const cut = chars.slice(0, TITLE_MAX - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space >= 20 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/u, "")}…`;
}

/** The post on Facebook: its text as written (the title when it has none), then "Čítať na webe: <address>". */
export function facebookMessage(title: string, body: string, url: string): string {
  const text = body.trim() ? body.replace(/\s+$/u, "") : title.trim();
  return `${text}\n\n${READ_ON_WEB} ${url}`;
}

/** A Cacaduu post's address: on the shop's live own domain ("/blog/<post>" in its language), else on Cacaduu. */
export function blogPostUrl(o: { siteUrl: string; host: string | null; country: string | null; shopSlug: string; postSlug: string }): string {
  if (o.host) return `https://${o.host}/blog/${o.postSlug}`;
  return `${o.siteUrl.replace(/\/+$/, "")}/${siteLang(o.country)}/shops/${o.shopSlug}/blog/${o.postSlug}`;
}

/** The slug of our own post a Facebook message links back to ("Čítať na webe: …/blog/<slug>"), or null. */
export function ownSlugIn(message: string): string | null {
  const at = message.lastIndexOf(READ_ON_WEB);
  if (at < 0) return null;
  const m = /^\s*(https?:\/\/\S+)/.exec(message.slice(at + READ_ON_WEB.length));
  if (!m) return null;
  try {
    const parts = new URL(m[1]).pathname.split("/").filter(Boolean);
    const i = parts.lastIndexOf("blog");
    const slug = i >= 0 ? parts[i + 1] : undefined;
    return slug && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && parts.length === i + 2 ? slug : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- a Facebook post → what the blog keeps

export interface FbImage {
  src?: string;
  width?: number;
  height?: number;
}
export interface FbAttachment {
  type?: string;
  media_type?: string;
  url?: string;
  unshimmed_url?: string;
  title?: string;
  description?: string;
  target?: { id?: string; url?: string };
  media?: { image?: FbImage };
  subattachments?: { data?: FbAttachment[] };
}
export interface FbPost {
  id: string;
  message?: string;
  created_time?: string;
  updated_time?: string;
  permalink_url?: string;
  is_published?: boolean;
  attachments?: { data?: FbAttachment[] };
}

export interface BlogLink {
  kind: "link" | "event";
  url: string;
  title: string | null;
  description: string | null;
}
export interface BlogMedia {
  kind: "photo" | "video";
  fb_media_id: string | null;
  source_url: string | null;
  link_url: string | null;
}
export interface ImportPost {
  fb_post_id: string;
  title: string;
  message: string;
  created: string | null;
  updated: string | null;
  permalink: string | null;
  links: BlogLink[];
  media: BlogMedia[];
  own_slug: string | null;
}

/** A web address (http or https) as Facebook gave it, or null. */
const webUrl = (value: string | undefined | null, max = 1000): string | null => {
  const v = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(v) || v.length > max) return null;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname ? v : null;
  } catch {
    return null;
  }
};
/** Pictures and video links: https only. */
const httpsUrl = (value: string | undefined | null, max = 1000): string | null => {
  const v = webUrl(value, max);
  return v && /^https:\/\//i.test(v) ? v : null;
};

/** Facebook's link wrapper (l.facebook.com/l.php?u=…) → the address the shop shared. */
export function unwrapLink(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)facebook\.com$/.test(u.hostname) && u.pathname === "/l.php" && u.searchParams.get("u")) return u.searchParams.get("u")!;
  } catch {
    // keep it as it was
  }
  return url;
}

/**
 * The 11-character id of a YouTube video address (watch, youtu.be, shorts, embed, live; www., m., music.), else null.
 * The same rule as public.youtube_id() and youtubeId() in src/lib/video.ts.
 */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase();
    let id: string | null = null;
    if (host === "youtu.be") id = u.pathname.split("/")[1] ?? null;
    else if (/^(www\.|m\.|music\.)?youtube(-nocookie)?\.com$/.test(host)) {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else {
        const m = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
        id = m ? m[2] : null;
      }
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** A YouTube video as a blog "video": its picture (the job tries the largest one first) and its address. */
export const youtubeMedia = (id: string): BlogMedia => ({
  kind: "video",
  fb_media_id: null,
  source_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  link_url: `https://www.youtube.com/watch?v=${id}`,
});

/** The pictures to try for a YouTube video, largest first (maxresdefault does not exist for every video). */
export function youtubePictures(source: string): string[] {
  const m = /^https:\/\/i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\/[a-z]+\.jpg$/.exec(source);
  return m ? [`https://i.ytimg.com/vi/${m[1]}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`] : [source];
}

const VIDEO_TYPES = new Set(["video", "video_inline", "video_autoplay", "video_direct_response", "animated_image_video", "animated_image_autoplay", "native_video", "reel"]);
const SKIP_TYPES = new Set(["profile_media", "cover_photo"]);

/**
 * What the blog keeps of a post: the text as written, its time, its address on Facebook, its photos (to download and
 * convert), videos and reels as their picture with a link (never downloaded), shared links and events as link cards.
 * A shared YouTube video (update 39) stays a link card and also becomes a "video" with YouTube's picture.
 * Null: not published, or nothing to show (a new profile or cover picture without words).
 */
export function mapPost(post: FbPost): ImportPost | null {
  if (!post || typeof post.id !== "string" || !FB_POST_ID.test(post.id) || post.is_published === false) return null;
  const message = typeof post.message === "string" ? post.message : "";
  const links: BlogLink[] = [];
  const media: BlogMedia[] = [];
  const add = (a: FbAttachment) => {
    const type = String(a.type ?? "").toLowerCase();
    if (SKIP_TYPES.has(type)) return;
    if (type === "album" || (a.subattachments?.data?.length ?? 0) > 0) {
      for (const sub of a.subattachments?.data ?? []) add(sub);
      return;
    }
    // A YouTube video, however Facebook labels it (share, video_share_youtube, media_type video).
    const shared = webUrl(a.unshimmed_url) ?? (a.url ? webUrl(unwrapLink(a.url)) : null) ?? webUrl(a.target?.url);
    const yt = youtubeId(shared);
    if (yt) {
      if (!media.some((m) => m.link_url === youtubeMedia(yt).link_url)) media.push(youtubeMedia(yt));
      const title = String(a.title ?? "").trim().slice(0, 300) || null;
      const description = String(a.description ?? "").trim().slice(0, 500) || null;
      if (!links.some((l) => l.url === shared)) links.push({ kind: "link", url: shared!, title, description });
      return;
    }
    const image = httpsUrl(a.media?.image?.src, 2000);
    const targetId = a.target?.id && FB_ID.test(String(a.target.id).split("_").pop() ?? "") ? String(a.target.id) : null;
    if (VIDEO_TYPES.has(type) || String(a.media_type ?? "").toLowerCase() === "video") {
      const link = httpsUrl(a.url) ?? httpsUrl(a.target?.url) ?? httpsUrl(post.permalink_url);
      if (image || link) media.push({ kind: "video", fb_media_id: targetId, source_url: image, link_url: link });
      return;
    }
    if (type === "photo" || (String(a.media_type ?? "").toLowerCase() === "photo" && type !== "share")) {
      if (image || targetId) media.push({ kind: "photo", fb_media_id: targetId, source_url: image, link_url: null });
      return;
    }
    const url = webUrl(a.unshimmed_url) ?? (a.url ? webUrl(unwrapLink(a.url)) : null) ?? webUrl(a.target?.url);
    if (!url) return;
    const title = String(a.title ?? "").trim().slice(0, 300) || null;
    const description = String(a.description ?? "").trim().slice(0, 500) || null;
    const kind = type === "event" ? "event" : "link";
    if (!links.some((l) => l.url === url)) links.push({ kind, url, title, description });
  };
  for (const a of post.attachments?.data ?? []) add(a);
  if (!message.trim() && !media.length && !links.length) return null;
  const permalink = post.permalink_url && PERMALINK.test(post.permalink_url) && post.permalink_url.length <= 500 ? post.permalink_url : null;
  return {
    fb_post_id: post.id,
    title: importTitle(message, links[0]?.title ?? null, post.created_time ?? null),
    message,
    created: post.created_time ?? null,
    updated: post.updated_time ?? post.created_time ?? null,
    permalink,
    links: links.slice(0, 20),
    media: media.slice(0, 100),
    own_slug: ownSlugIn(message),
  };
}

// ---------------------------------------------------------------- Facebook's Graph API

export class FacebookError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
    message: string,
  ) {
    super(message);
  }
  /** The token no longer works (expired, revoked, the password changed, the Page role or a permission is gone). */
  get expired(): boolean {
    return this.code === 190 || this.code === 102 || this.code === 10 || (this.code !== null && this.code >= 200 && this.code < 300);
  }
  /** The thing asked for does not exist (any more): Facebook's "object does not exist" (code 100, subcode 33). */
  get missing(): boolean {
    return this.code === 100 && this.subcode === 33;
  }
}

export interface FacebookConfig {
  appId: string;
  appSecret: string;
  /** Facebook Login for Business: the configuration with the permissions; without it the classic scope list. */
  configId: string | null;
}

export interface PageChoice {
  id: string;
  name: string;
  picture: string | null;
  token: string;
}

type Fetch = typeof fetch;

/** The calls the blog makes; every one with appsecret_proof, nothing of a token in an error text. */
export class Graph {
  constructor(
    readonly config: FacebookConfig,
    private readonly f: Fetch,
    readonly graphBase = "https://graph.facebook.com",
    readonly dialogBase = "https://www.facebook.com",
  ) {}

  loginUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ client_id: this.config.appId, redirect_uri: redirectUri, state, response_type: "code" });
    if (this.config.configId) q.set("config_id", this.config.configId);
    else q.set("scope", SCOPES.join(","));
    return `${this.dialogBase}/${GRAPH_VERSION}/dialog/oauth?${q}`;
  }

  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string>, token: string | null): Promise<T> {
    const q = new URLSearchParams(params);
    if (token) {
      q.set("access_token", token);
      q.set("appsecret_proof", await hmacHex(this.config.appSecret, token));
    }
    const url = `${this.graphBase}/${GRAPH_VERSION}/${path.replace(/^\//, "")}`;
    const res = await this.f(method === "GET" ? `${url}?${q}` : url, {
      method,
      ...(method === "GET" ? {} : { body: q, headers: { "Content-Type": "application/x-www-form-urlencoded" } }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let data: Json = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    const err = data.error as { message?: string; code?: number; error_subcode?: number } | undefined;
    if (!res.ok || err) {
      throw new FacebookError(res.status, err?.code ?? null, err?.error_subcode ?? null, String(err?.message ?? `HTTP ${res.status}`).slice(0, 300));
    }
    return data as T;
  }

  async exchange(code: string, redirectUri: string): Promise<string> {
    const { client_id, client_secret } = { client_id: this.config.appId, client_secret: this.config.appSecret };
    const short = await this.call<{ access_token?: string }>("GET", "oauth/access_token", { client_id, client_secret, redirect_uri: redirectUri, code }, null);
    if (!short.access_token) throw new FacebookError(400, null, null, "no access token");
    // A long-lived user token: the Page tokens made with it do not expire.
    const long = await this.call<{ access_token?: string }>(
      "GET",
      "oauth/access_token",
      { grant_type: "fb_exchange_token", client_id, client_secret, fb_exchange_token: short.access_token },
      null,
    );
    return long.access_token ?? short.access_token;
  }

  async grantedScopes(userToken: string): Promise<string[]> {
    const r = await this.call<{ data?: { permission: string; status: string }[] }>("GET", "me/permissions", {}, userToken).catch(() => ({ data: [] }));
    return (r.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
  }

  /** The Pages the person runs (personal profiles cannot be chosen: they are no Pages). */
  async pages(userToken: string): Promise<PageChoice[]> {
    const out: PageChoice[] = [];
    let after = "";
    for (let i = 0; i < 5; i++) {
      const r = await this.call<{
        data?: { id: string; name: string; access_token?: string; picture?: { data?: { url?: string } } }[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>(
        "GET",
        "me/accounts",
        { fields: "id,name,access_token,picture{url}", limit: "100", ...(after ? { after } : {}) },
        userToken,
      );
      for (const p of r.data ?? []) {
        if (FB_ID.test(String(p.id)) && p.access_token && p.name) {
          out.push({ id: String(p.id), name: String(p.name).slice(0, 200), picture: httpsUrl(p.picture?.data?.url, 2000), token: p.access_token });
        }
      }
      if (!r.paging?.next || !r.paging.cursors?.after) break;
      after = r.paging.cursors.after;
    }
    return out;
  }

  async page(token: string, pageId: string): Promise<{ name: string | null; picture: string | null }> {
    const r = await this.call<{ name?: string; picture?: { data?: { url?: string } } }>("GET", pageId, { fields: "name,picture{url}" }, token);
    return { name: r.name ? String(r.name).slice(0, 200) : null, picture: httpsUrl(r.picture?.data?.url, 2000) };
  }

  /** One page of the Page's own posts, newest first: {posts, after} (after = null at the end). */
  async posts(token: string, pageId: string, o: { after?: string; since?: number } = {}): Promise<{ posts: FbPost[]; after: string | null }> {
    const r = await this.call<{ data?: FbPost[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      "GET",
      `${pageId}/posts`,
      {
        fields: POST_FIELDS,
        limit: String(PAGE_SIZE),
        ...(o.after ? { after: o.after } : {}),
        ...(o.since ? { since: String(o.since) } : {}),
      },
      token,
    );
    const after = r.paging?.next && r.paging.cursors?.after ? r.paging.cursors.after.slice(0, 2000) : null;
    return { posts: r.data ?? [], after };
  }

  /** Several posts at once (Graph batch, ≤ 50): each the post, "missing" (deleted) or an error. */
  async postsById(token: string, ids: string[]): Promise<Map<string, FbPost | "missing" | "error">> {
    const batch = ids.slice(0, 50).map((id) => ({ method: "GET", relative_url: `${id}?fields=${encodeURIComponent(POST_FIELDS)}` }));
    const r = await this.call<unknown>("POST", "", { batch: JSON.stringify(batch), include_headers: "false" }, token);
    const out = new Map<string, FbPost | "missing" | "error">();
    const rows = Array.isArray(r) ? r : [];
    ids.slice(0, 50).forEach((id, i) => {
      const row = rows[i] as { code?: number; body?: string } | null;
      if (!row) return out.set(id, "error");
      let body: Json = {};
      try {
        body = JSON.parse(row.body ?? "{}");
      } catch {
        body = {};
      }
      const err = body.error as { code?: number; error_subcode?: number } | undefined;
      if (row.code === 200 && !err) return out.set(id, body as unknown as FbPost);
      const e = new FacebookError(row.code ?? 500, err?.code ?? null, err?.error_subcode ?? null, "batch");
      if (e.expired) throw new FacebookError(row.code ?? 400, err?.code ?? null, err?.error_subcode ?? null, "token");
      out.set(id, e.missing ? "missing" : "error");
    });
    // Every one of several posts "gone" at once is more likely a problem of the request than deletions: none hidden.
    const values = [...out.values()];
    if (values.length > 3 && values.every((v) => v === "missing")) for (const id of out.keys()) out.set(id, "error");
    return out;
  }

  /** The address of a photo's largest picture up to `width` (the smallest that is at least that wide). */
  async photoSource(token: string, photoId: string, width: number): Promise<string | null> {
    const r = await this.call<{ images?: { width?: number; height?: number; source?: string }[] }>("GET", photoId, { fields: "images" }, token);
    const images = (r.images ?? []).filter((i) => httpsUrl(i.source, 2000) && Number(i.width) > 0).sort((a, b) => Number(a.width) - Number(b.width));
    const pick = images.find((i) => Number(i.width) >= width) ?? images[images.length - 1];
    return pick ? httpsUrl(pick.source, 2000) : null;
  }

  async uploadPhoto(token: string, pageId: string, url: string): Promise<string> {
    const r = await this.call<{ id?: string }>("POST", `${pageId}/photos`, { url, published: "false" }, token);
    if (!r.id) throw new FacebookError(500, null, null, "no photo id");
    return String(r.id);
  }

  async publish(token: string, pageId: string, message: string, mediaIds: string[], link: string | null): Promise<string> {
    const params: Record<string, string> = { message };
    if (mediaIds.length) params.attached_media = JSON.stringify(mediaIds.map((id) => ({ media_fbid: id })));
    else if (link) params.link = link;
    const r = await this.call<{ id?: string }>("POST", `${pageId}/feed`, params, token);
    if (!r.id || !FB_POST_ID.test(String(r.id))) throw new FacebookError(500, null, null, "no post id");
    return String(r.id);
  }

  async permalink(token: string, postId: string): Promise<string | null> {
    const r = await this.call<{ permalink_url?: string }>("GET", postId, { fields: "permalink_url" }, token);
    return r.permalink_url && PERMALINK.test(r.permalink_url) && r.permalink_url.length <= 500 ? r.permalink_url : null;
  }

  /** Page feed changes to the webhook (only when the Page granted pages_manage_metadata). */
  async subscribe(token: string, pageId: string): Promise<void> {
    await this.call("POST", `${pageId}/subscribed_apps`, { subscribed_fields: "feed" }, token);
  }
}

/** The text for the owner when Facebook refused (the web post stays either way). */
export function facebookReason(e: unknown): string {
  if (e instanceof FacebookError && e.expired) return "Pripojenie k Facebooku vypršalo – pripojte znova.";
  if (e instanceof FacebookError) return `Facebook: ${e.message}`.slice(0, 300);
  return `Facebook neodpovedal (${e instanceof Error ? e.name : "chyba"}).`;
}

// ---------------------------------------------------------------- pictures: WebP 1600 / 800 px

export interface Picture {
  type: "webp" | "jpg";
  width: number;
  height: number;
}

/** The type (by the first bytes) and pixel size of a WebP or JPEG picture, or null. */
export function sniffPicture(b: Uint8Array): Picture | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const chunk = ascii(12, 16);
    if (chunk === "VP8X") {
      return { type: "webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { type: "webp", width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpg", width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + length;
    }
  }
  return null;
}

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Smaller by area averaging (each new pixel = the mean of the pixels it covers); never larger. */
export function shrink(src: Pixels, width: number): Pixels {
  if (width >= src.width) return src;
  const height = Math.max(1, Math.round((src.height * width) / src.width));
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  const out = new Uint8ClampedArray(width * height * 4);
  const fx = sw / width;
  const fy = sh / height;
  const row = new Float32Array(width * 4);
  for (let y = 0; y < height; y++) {
    row.fill(0);
    const y0 = y * fy;
    const y1 = y0 + fy;
    let wsum = 0;
    for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
      const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
      wsum += wy;
      const base = sy * sw * 4;
      for (let x = 0; x < width; x++) {
        const x0 = x * fx;
        const x1 = x0 + fx;
        let r = 0, g = 0, b = 0, a = 0, wx = 0;
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const w = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const i = base + sx * 4;
          r += s[i] * w;
          g += s[i + 1] * w;
          b += s[i + 2] * w;
          a += s[i + 3] * w;
          wx += w;
        }
        const o = x * 4;
        row[o] += (r / wx) * wy;
        row[o + 1] += (g / wx) * wy;
        row[o + 2] += (b / wx) * wy;
        row[o + 3] += (a / wx) * wy;
      }
    }
    const ob = y * width * 4;
    for (let i = 0; i < width * 4; i++) out[ob + i] = row[i] / wsum;
  }
  return { data: out, width, height };
}

/** Turns a downloaded picture into a WebP at most `width` px wide (injectable: the tests use a stand-in). */
export interface Images {
  webp(bytes: Uint8Array, width: number): Promise<{ bytes: Uint8Array; width: number; height: number }>;
}

let codecs: Promise<void> | null = null;

/** The WebAssembly codecs (mozjpeg, libwebp), read from their npm packages once per worker. */
function loadCodecs(): Promise<void> {
  codecs ??= (async () => {
    // The decoders expect the browser's ImageData.
    const g = globalThis as unknown as { ImageData?: unknown };
    g.ImageData ??= class {
      constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
    };
    const wasm = async (spec: string, file: string) => await WebAssembly.compile(await Deno.readFile(new URL(file, import.meta.resolve(spec))));
    await initJpegDecode(await wasm("npm:@jsquash/jpeg@1.6.0/decode.js", "./codec/dec/mozjpeg_dec.wasm"));
    await initWebpDecode(await wasm("npm:@jsquash/webp@1.5.0/decode.js", "./codec/dec/webp_dec.wasm"));
    // The SIMD build where the runtime has SIMD (the library picks the matching glue code itself).
    const simd = await wasm("npm:@jsquash/webp@1.5.0/encode.js", "./codec/enc/webp_enc_simd.wasm").catch(() => null);
    await initWebpEncode(simd ?? (await wasm("npm:@jsquash/webp@1.5.0/encode.js", "./codec/enc/webp_enc.wasm")));
  })().catch((e) => {
    codecs = null;
    throw e;
  });
  return codecs;
}

export const wasmImages: Images = {
  async webp(bytes, width) {
    const info = sniffPicture(bytes);
    if (!info) throw new Error("not a JPEG or WebP picture");
    // A WebP that is already small enough is kept as it is.
    if (info.type === "webp" && info.width <= width) return { bytes, width: info.width, height: info.height };
    await loadCodecs();
    const decoded = (info.type === "jpg" ? await decodeJpeg(bytes.buffer as ArrayBuffer) : await decodeWebp(bytes.buffer as ArrayBuffer)) as unknown as Pixels;
    const small = shrink(decoded, width);
    const out = await encodeWebp(small as unknown as ImageData, { quality: 80, method: 4 });
    return { bytes: new Uint8Array(out), width: small.width, height: small.height };
  },
};

// ---------------------------------------------------------------- dependencies

export interface Storage {
  put(path: string, bytes: Uint8Array, type: string): Promise<void>;
  get(path: string): Promise<Uint8Array | null>;
  remove(paths: string[]): Promise<void>;
}

export interface Deps {
  /** Service role: the database functions and the bucket. */
  db: SupabaseClient;
  /** The caller's own login (owners, the admin): the database decides what they may do. */
  asCaller: (authorization: string) => SupabaseClient;
  /** null: FACEBOOK_APP_ID / FACEBOOK_APP_SECRET not set (everything Facebook off). */
  graph: Graph | null;
  /** FB_TOKEN_ENCRYPTION_KEY, or null. */
  tokenSecret: string | null;
  serviceKey: string | null;
  /** <SUPABASE_URL>/functions/v1/shop-blog */
  functionUrl: string;
  /** <SUPABASE_URL>/storage/v1/object/public/blog-photos/ */
  publicBase: string;
  /** SITE_URL: Cacaduu's own address (the posts' addresses, IndexNow). */
  siteUrl: string | null;
  indexNowKey: string | null;
  indexNowEndpoint: string;
  email: { apiKey: string; from: string } | null;
  storage: Storage;
  images: Images;
  /** Hosts pictures may be downloaded from (Facebook's). */
  mediaHosts: string[];
  fetch: Fetch;
  /** The next step of a long job, in a new call of this function (each call has its own 2 s of CPU). */
  chain: (body: Json) => Promise<void>;
  background: (task: Promise<unknown>) => void;
  now: () => number;
}

/** The next step in the background: this call answers now, the next one does its own part. */
const next = (deps: Deps, body: Json) => deps.background(deps.chain(body).catch(() => {}));

const facebookOn = (deps: Deps) => Boolean(deps.graph && deps.tokenSecret && deps.tokenSecret.length >= 32);

async function rpc<T>(deps: Deps, name: string, args: Json = {}): Promise<T> {
  const { data, error } = await deps.db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

// ---------------------------------------------------------------- the connection in use

interface Connection {
  shop_id: string;
  page_id: string;
  page_name: string;
  page_token_enc: string;
  status: "ok" | "expired";
  connected_at: string;
  shop_slug: string;
  shop_country: string | null;
}

async function connectionOf(deps: Deps, shopId: string): Promise<Connection | null> {
  return (await rpc<Connection | null>(deps, "facebook_connection_of", { p_shop_id: shopId })) ?? null;
}

async function pageToken(deps: Deps, c: Connection): Promise<string> {
  if (!deps.tokenSecret) throw new Error("FB_TOKEN_ENCRYPTION_KEY is not set");
  return await decryptToken(await tokenKey(deps.tokenSecret), c.page_token_enc, pageBind(c.shop_id, c.page_id));
}

/** Facebook refused the token: the connection is expired (the owner sees it and gets one e-mail). */
async function expire(deps: Deps, shopId: string, e: FacebookError) {
  await deps.db.rpc("facebook_connection_result", { p_shop_id: shopId, p_error: `Facebook: ${e.message}`.slice(0, 300), p_expired: true });
}

// ---------------------------------------------------------------- import and sync

async function removeFiles(deps: Deps, paths: unknown) {
  const list = (Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === "string" && p.length > 0);
  if (list.length) await deps.storage.remove(list).catch(() => {});
}

/** One post from the Page into the blog (blog_import_post decides: new, updated, same, own, linked). */
export async function importOne(deps: Deps, shopId: string, post: FbPost): Promise<string> {
  const mapped = mapPost(post);
  if (!mapped) return "skipped";
  const result = await rpc<{ result: string; removed?: unknown }>(deps, "blog_import_post", {
    p_shop_id: shopId,
    p_fb_post_id: mapped.fb_post_id,
    p_title: mapped.title,
    p_message: mapped.message,
    p_created: mapped.created,
    p_updated: mapped.updated,
    p_permalink: mapped.permalink,
    p_links: mapped.links,
    p_media: mapped.media,
    p_own_slug: mapped.own_slug,
  });
  await removeFiles(deps, result.removed);
  return result.result;
}

/**
 * "Stiahnuť všetky príspevky": one page (25 posts) per call, newest first; the next page in a new call. Returns
 * {imported, more}; nothing when no import runs or another call has it.
 */
export async function importStep(deps: Deps, shopId: string): Promise<{ imported: number; more: boolean } | null> {
  const graph = deps.graph;
  if (!graph) return null;
  const taken = await rpc<{ cursor: string } | null>(deps, "facebook_import_take", { p_shop_id: shopId });
  if (!taken) return null;
  const c = await connectionOf(deps, shopId);
  if (!c || c.status !== "ok") return null;
  try {
    const token = await pageToken(deps, c);
    const { posts, after } = await graph.posts(token, c.page_id, { after: taken.cursor || undefined });
    let imported = 0;
    for (const post of posts) if ((await importOne(deps, shopId, post)) === "new") imported++;
    await rpc(deps, "facebook_import_step", { p_shop_id: shopId, p_cursor: after, p_count: imported, p_error: null });
    if (after) next(deps, { action: "work", kind: "import", shop_id: shopId });
    if (posts.length) next(deps, { action: "work", kind: "photo" });
    return { imported, more: Boolean(after) };
  } catch (e) {
    if (e instanceof FacebookError && e.expired) await expire(deps, shopId, e);
    await rpc(deps, "facebook_import_step", { p_shop_id: shopId, p_cursor: null, p_count: 0, p_error: facebookReason(e) });
    console.error("shop-blog: import failed", e instanceof FacebookError ? `code ${e.code}` : failText(e).slice(0, 120));
    return { imported: 0, more: false };
  }
}

/**
 * The daily sync of one Page: its name and picture, the posts since the newest one imported (a two-day margin, at
 * most 100), then up to 100 imported posts looked at again (edited → updated, deleted on Facebook → hidden).
 */
export async function syncShop(deps: Deps, shopId: string): Promise<{ new: number; updated: number; deleted: number }> {
  const out = { new: 0, updated: 0, deleted: 0 };
  const graph = deps.graph;
  const c = await connectionOf(deps, shopId);
  if (!graph || !c || c.status !== "ok") return out;
  try {
    const token = await pageToken(deps, c);
    const page = await graph.page(token, c.page_id);
    // Never the Page's older posts unless the owner asked ("Stiahnuť všetky príspevky"): before the first import,
    // only what was posted since the Page was connected.
    const newest = await rpc<string | null>(deps, "facebook_newest_import", { p_shop_id: shopId });
    const since = Math.floor(Date.parse(newest ?? c.connected_at) / 1000) - (newest ? 2 * 86400 : 0);
    let after: string | undefined;
    for (let n = 0; n < 4; n++) {
      const r = await graph.posts(token, c.page_id, { after, since });
      for (const post of r.posts) {
        const result = await importOne(deps, shopId, post);
        if (result === "new") out.new++;
        if (result === "updated") out.updated++;
      }
      if (!r.after) break;
      after = r.after;
    }
    const check = await rpc<{ post_id: string; fb_post_id: string }[]>(deps, "blog_posts_to_check", { p_shop_id: shopId, p_limit: 100 });
    for (let i = 0; i < check.length; i += 50) {
      const ids = check.slice(i, i + 50).map((r) => r.fb_post_id);
      const found = await graph.postsById(token, ids);
      const gone: string[] = [];
      const same: string[] = [];
      for (const id of ids) {
        const r = found.get(id);
        if (r === "missing") gone.push(id);
        else if (r && r !== "error") {
          const result = await importOne(deps, shopId, r);
          if (result === "updated") out.updated++;
          else same.push(id);
        }
      }
      if (gone.length) out.deleted += await rpc<number>(deps, "blog_posts_deleted_on_facebook", { p_shop_id: shopId, p_fb_post_ids: gone });
      if (same.length) await rpc(deps, "blog_posts_checked", { p_shop_id: shopId, p_fb_post_ids: same });
    }
    await rpc(deps, "facebook_sync_done", { p_shop_id: shopId, p_page_name: page.name, p_page_picture: page.picture, p_error: null });
    if (out.new || out.updated) next(deps, { action: "work", kind: "photo" });
  } catch (e) {
    if (e instanceof FacebookError && e.expired) await expire(deps, shopId, e);
    else await deps.db.rpc("facebook_sync_done", { p_shop_id: shopId, p_page_name: null, p_page_picture: null, p_error: facebookReason(e) });
    console.error("shop-blog: sync failed", e instanceof FacebookError ? `code ${e.code}` : failText(e).slice(0, 120));
  }
  return out;
}

// ---------------------------------------------------------------- photos from Facebook

interface PhotoRow {
  id: string;
  post_id: string;
  shop_id: string;
  fb_media_id: string | null;
  source_url: string | null;
  kind: "photo" | "video";
  path_large: string | null;
  path_small: string | null;
}

export function mediaAllowed(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && hosts.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
  } catch {
    return false;
  }
}

async function download(deps: Deps, url: string): Promise<Uint8Array> {
  if (!mediaAllowed(url, deps.mediaHosts)) throw new Error("not a Facebook or YouTube picture address");
  const res = await deps.fetch(url, { headers: { Accept: "image/jpeg,image/webp;q=0.9" }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`picture: HTTP ${res.status}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_DOWNLOAD_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("picture too big");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

const photoPath = (p: PhotoRow, size: number, ext: string) => `${p.shop_id}/${p.post_id}/${p.id}-${size}.${ext}`;

/**
 * One imported photo, one size per call (2 s of CPU each): the 1600 px WebP from Facebook's largest picture, then
 * the 800 px one from it. Then the next photo, in a new call. False: nothing to do.
 */
export async function photoStep(deps: Deps, photoId: string | null): Promise<boolean> {
  let row: PhotoRow | null = null;
  if (photoId && UUID.test(photoId)) {
    const { data } = await deps.db
      .from("blog_photos")
      .select("id, post_id, shop_id, fb_media_id, source_url, kind, path_large, path_small")
      .eq("id", photoId)
      .eq("status", "pending")
      .maybeSingle();
    row = (data as PhotoRow | null) ?? null;
  }
  if (!row) row = ((await rpc<PhotoRow[]>(deps, "blog_photos_due", { p_limit: 1 })) ?? [])[0] ?? null;
  if (!row) return false;
  try {
    if (!row.path_large) {
      let source = row.source_url;
      // A photo: Facebook's largest picture of it (the post's attachment is often only 720 px).
      if (row.kind === "photo" && row.fb_media_id && deps.graph) {
        const c = await connectionOf(deps, row.shop_id);
        if (c?.status === "ok") {
          const better = await deps.graph.photoSource(await pageToken(deps, c), row.fb_media_id, 1600).catch(() => null);
          if (better) source = better;
        }
      }
      if (!source) throw new Error("no picture address");
      // A YouTube picture: the largest that exists (update 39).
      let bytes: Uint8Array | null = null;
      for (const [i, url] of youtubePictures(source).entries()) {
        try {
          bytes = await download(deps, url);
          break;
        } catch (e) {
          if (i === youtubePictures(source).length - 1) throw e;
        }
      }
      const out = await deps.images.webp(bytes!, 1600);
      const path = photoPath(row, 1600, "webp");
      await deps.storage.put(path, out.bytes, "image/webp");
      await rpc(deps, "blog_photo_stored", {
        p_photo_id: row.id, p_size: 1600, p_path: path, p_ext: "webp", p_width: out.width, p_height: out.height, p_last: out.width <= 800,
      });
      next(deps, out.width > 800 ? { action: "work", kind: "photo", photo_id: row.id } : { action: "work", kind: "photo" });
    } else {
      const large = await deps.storage.get(row.path_large);
      if (!large) throw new Error("the large picture is missing");
      const out = await deps.images.webp(large, 800);
      const path = photoPath(row, 800, "webp");
      await deps.storage.put(path, out.bytes, "image/webp");
      await rpc(deps, "blog_photo_stored", {
        p_photo_id: row.id, p_size: 800, p_path: path, p_ext: "webp", p_width: out.width, p_height: out.height, p_last: true,
      });
      next(deps, { action: "work", kind: "photo" });
    }
  } catch (e) {
    await deps.db.rpc("blog_photo_failed", { p_photo_id: row.id, p_error: failText(e).slice(0, 300) });
    console.error("shop-blog: photo failed", failText(e).slice(0, 120));
  }
  return true;
}

// ---------------------------------------------------------------- publishing to the Page

/**
 * A Cacaduu post on the Page, as the Page: its text, up to 10 of its photos and "Čítať na webe: <address>". Facebook's
 * post id is kept (the import never brings it back as a new post). On failure the web post stays and the owner gets
 * "Skúsiť znova na Facebook".
 */
export async function publishToFacebook(deps: Deps, postId: string, retry: boolean): Promise<{ ok: boolean; permalink?: string | null; error?: string }> {
  const claim = await rpc<{ post_id: string; shop_id: string; shop_slug: string; shop_country: string | null; slug: string; title: string; body: string; photos: string[] } | null>(
    deps,
    "blog_fb_claim",
    { p_post_id: postId, p_retry: retry },
  );
  if (!claim) return { ok: false, error: "not_waiting" };
  const fail = async (text: string) => {
    await rpc(deps, "blog_fb_result", { p_post_id: postId, p_fb_post_id: null, p_permalink: null, p_error: text });
    return { ok: false, error: text };
  };
  const graph = deps.graph;
  const c = await connectionOf(deps, claim.shop_id);
  if (!graph || !c || c.status !== "ok" || !deps.siteUrl) {
    return await fail(!deps.siteUrl ? "SITE_URL nie je nastavené." : c?.status === "expired" ? "Pripojenie k Facebooku vypršalo – pripojte znova." : "Facebook nie je pripojený.");
  }
  try {
    const token = await pageToken(deps, c);
    const { data: host } = await deps.db.rpc("shop_site", { p_slug: claim.shop_slug });
    const url = blogPostUrl({ siteUrl: deps.siteUrl, host: typeof host === "string" && host ? host : null, country: claim.shop_country, shopSlug: claim.shop_slug, postSlug: claim.slug });
    const media: string[] = [];
    for (const path of (claim.photos ?? []).slice(0, MAX_FB_PHOTOS)) media.push(await graph.uploadPhoto(token, c.page_id, deps.publicBase + path));
    const id = await graph.publish(token, c.page_id, facebookMessage(claim.title, claim.body, url), media, media.length ? null : url);
    const permalink = await graph.permalink(token, id).catch(() => null);
    await rpc(deps, "blog_fb_result", { p_post_id: postId, p_fb_post_id: id, p_permalink: permalink, p_error: null });
    return { ok: true, permalink };
  } catch (e) {
    if (e instanceof FacebookError && e.expired) await expire(deps, claim.shop_id, e);
    console.error("shop-blog: publish failed", e instanceof FacebookError ? `code ${e.code}` : failText(e).slice(0, 120));
    return await fail(facebookReason(e));
  }
}

// ---------------------------------------------------------------- IndexNow for posts

export interface BlogIndexNowClaim {
  host: string;
  kind: "main" | "site";
  at: string;
  posts: { id: string; shop_slug: string; slug: string; country: string | null }[];
}

/** Every address of the claimed posts on that host: each post and its shop's blog page, in the three languages. */
export function blogIndexNowUrls(claim: BlogIndexNowClaim): string[] {
  const base = `https://${claim.host}`;
  const urls = new Set<string>();
  for (const p of claim.posts) {
    if (claim.kind === "site") {
      const home = siteLang(p.country);
      for (const l of LANGS) {
        const prefix = l === home ? "" : `/${l}`;
        urls.add(`${base}${prefix}/blog/${p.slug}`);
        urls.add(`${base}${prefix}/blog`);
      }
    } else {
      for (const l of LANGS) {
        urls.add(`${base}/${l}/shops/${p.shop_slug}/blog/${p.slug}`);
        urls.add(`${base}/${l}/shops/${p.shop_slug}/blog`);
      }
    }
  }
  return [...urls].slice(0, 10_000);
}

export function mainHostOf(siteUrl: string | null): string | null {
  try {
    const u = new URL(String(siteUrl ?? ""));
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && HOST.test(host) && host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** Up to 5 hosts per run, each at most once an hour (shared with the stock's pings); only a 2xx counts as sent. */
export async function pingBlogIndexNow(deps: Deps): Promise<number> {
  if (!deps.indexNowKey || !/^[A-Za-z0-9-]{8,128}$/.test(deps.indexNowKey)) return 0;
  let sent = 0;
  for (let i = 0; i < 5; i++) {
    const claim = await rpc<BlogIndexNowClaim | null>(deps, "blog_indexnow_claim", { p_main_host: mainHostOf(deps.siteUrl), p_max: 500 });
    if (!claim) break;
    const urls = blogIndexNowUrls(claim);
    let status: number | null = null;
    let result: string;
    try {
      const res = await deps.fetch(deps.indexNowEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: claim.host, key: deps.indexNowKey, keyLocation: `https://${claim.host}/${deps.indexNowKey}.txt`, urlList: urls }),
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      await res.body?.cancel().catch(() => {});
      result = String(res.status);
    } catch (e) {
      result = `failed: ${e instanceof Error ? e.name : "error"}`;
    }
    await rpc(deps, "blog_indexnow_done", {
      p_host: claim.host, p_kind: claim.kind, p_at: claim.at, p_ids: claim.posts.map((p) => p.id), p_urls: urls.length, p_status: status, p_result: result,
    });
    console.log(`shop-blog: IndexNow ${claim.host}: ${urls.length} addresses, answer ${result}`);
    if (status !== null && status >= 200 && status < 300) sent += urls.length;
  }
  return sent;
}

// ---------------------------------------------------------------- the e-mail when the connection expired

interface Alert {
  shop_id: string;
  shop_name: string;
  shop_slug: string;
  page_name: string;
  site_url: string | null;
  emails: string[];
}

export const ALERT_SUBJECT = "Pripojenie k Facebooku vypršalo – pripojte znova";

export function alertText(a: Alert): string {
  const link = a.site_url ? `${a.site_url.replace(/\/+$/, "")}/sk/dashboard/blog?shop=${encodeURIComponent(a.shop_slug)}#facebook` : null;
  return [
    "Dobrý deň,",
    "",
    `pripojenie obchodu ${a.shop_name} k Facebook stránke ${a.page_name} vypršalo: nové príspevky sa zo stránky nesťahujú ` +
      "a články z Cacaduu sa na ňu nezverejňujú.",
    "",
    "Pripojte stránku znova v Môj obchod → Novinky / Blog" + (link ? `:\n${link}` : "."),
    "",
    "Príspevky, ktoré už sú na webe, zostávajú.",
    "",
    "Cacaduu PPI",
  ].join("\n");
}

async function sendAlerts(deps: Deps): Promise<number> {
  const due = (await rpc<Alert[]>(deps, "facebook_alerts_due")) ?? [];
  if (!due.length) return 0;
  if (!deps.email) {
    console.error("shop-blog: alert e-mail not sent (BREVO_API_KEY or ALERT_EMAIL_FROM missing)");
    return 0;
  }
  let sent = 0;
  for (const alert of due) {
    if (!alert.emails.length) continue;
    const res = await deps.fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": deps.email.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "Cacaduu PPI", email: deps.email.from },
        to: alert.emails.map((email) => ({ email })),
        subject: ALERT_SUBJECT,
        textContent: alertText(alert),
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    await res?.body?.cancel().catch(() => {});
    if (res?.ok) {
      await rpc(deps, "facebook_alert_sent", { p_shop_id: alert.shop_id });
      sent++;
    } else {
      console.error("shop-blog: alert e-mail failed", res?.status ?? "network");
    }
  }
  return sent;
}

// ---------------------------------------------------------------- the job

export async function tick(deps: Deps): Promise<Json> {
  const started = deps.now();
  const left = () => TICK_BUDGET_MS - (deps.now() - started);
  const out: Json = { facebook: 0, imports: 0, synced: 0, indexnow: 0, alerts: 0, swept: 0 };
  if (facebookOn(deps)) {
    // 1. "Web + Facebook" copies whose time has come
    for (const id of (await rpc<string[]>(deps, "blog_fb_due", { p_limit: 5 })) ?? []) {
      if (left() < 20_000) break;
      if ((await publishToFacebook(deps, id, false)).ok) out.facebook = Number(out.facebook) + 1;
    }
    // 2. imports whose chain of calls broke off
    for (const shopId of (await rpc<string[]>(deps, "facebook_imports_stalled", { p_limit: 3 })) ?? []) {
      next(deps, { action: "work", kind: "import", shop_id: shopId });
      out.imports = Number(out.imports) + 1;
    }
    // 3. the daily sync (and the Pages a webhook asked for)
    for (const shopId of (await rpc<string[]>(deps, "facebook_sync_due", { p_limit: 3 })) ?? []) {
      if (left() < 30_000) break;
      await syncShop(deps, shopId);
      out.synced = Number(out.synced) + 1;
    }
  }
  // 4. photos waiting for their WebP (also after the Page was disconnected: their addresses may still work)
  const { data: waiting } = await deps.db.from("blog_photos").select("id").eq("status", "pending")
    .lte("next_try_at", new Date(deps.now()).toISOString()).limit(1);
  if (waiting?.length) next(deps, { action: "work", kind: "photo" });
  // 5. IndexNow, 6. the expiry e-mail, 7. unused files
  out.indexnow = await pingBlogIndexNow(deps).catch((e) => (console.error("shop-blog: IndexNow", failText(e).slice(0, 120)), 0));
  out.alerts = await sendAlerts(deps).catch(() => 0);
  await deps.db.rpc("blog_stale_uploads");
  const orphans = ((await deps.db.rpc("blog_orphan_files", { p_limit: 200 })).data ?? []) as string[];
  await removeFiles(deps, orphans);
  out.swept = orphans.length;
  return out;
}

// ---------------------------------------------------------------- owners

async function caller(req: Request, deps: Deps): Promise<{ authorization: string; userId: string } | null> {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data } = await deps.asCaller(authorization).auth.getUser(token);
  return data?.user ? { authorization, userId: data.user.id } : null;
}

async function member(deps: Deps, authorization: string, shopId: string): Promise<boolean> {
  if (!UUID.test(shopId)) return false;
  const { data } = await deps.asCaller(authorization).rpc("is_shop_member", { p_shop_id: shopId });
  return data === true;
}

/** The post, read with the owner's own login (the database refuses other shops' posts). */
async function ownPost(deps: Deps, authorization: string, postId: string): Promise<{ id: string; shop_id: string; source: string; status: string } | null> {
  if (!UUID.test(postId)) return null;
  const { data, error } = await deps.asCaller(authorization).rpc("owner_blog_post", { p_post_id: postId });
  return error || !data ? null : (data as { id: string; shop_id: string; source: string; status: string });
}

/** The way back to Môj obchod → Novinky / Blog (an editor page included). */
const RETURN_URL = /^https?:\/\/[^/?#\s]+\/[a-z]{2}\/dashboard\/blog(\/[A-Za-z0-9-]+)?(\?[^#\s]*)?$/;

function backTo(url: string, query: string) {
  const [base] = url.split("#");
  return new Response(null, {
    status: 302,
    headers: { Location: `${base}${base.includes("?") ? "&" : "?"}${query}#facebook`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

function errorPage(text: string) {
  return new Response(
    `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Cacaduu PPI</title></head><body style="font-family:sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">Pripojenie Facebooku sa nepodarilo</h1><p>${text}</p></body></html>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

const redirectUri = (deps: Deps) => `${deps.functionUrl}/oauth`;

/** GET …/oauth?code=&state=: Facebook's answer → the Pages to pick from (encrypted, 10 minutes). */
async function callback(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  if (!state) return errorPage("Odkaz nie je platný. Zatvorte toto okno a skúste to znova v Môj obchod → Novinky / Blog.");
  const st = await rpc<{ shop_id: string; user_id: string; return_url: string } | null>(deps, "facebook_state_take", { p_state_hash: await sha256Hex(state) });
  if (!st) return errorPage("Odkaz vypršal alebo už bol použitý. Zatvorte toto okno a skúste to znova v Môj obchod → Novinky / Blog.");
  if (url.searchParams.get("error") || !url.searchParams.get("code")) return backTo(st.return_url, "err=fb_denied");
  const graph = deps.graph;
  if (!graph || !facebookOn(deps)) return backTo(st.return_url, "err=fb_not_configured");
  try {
    const userToken = await graph.exchange(url.searchParams.get("code")!, redirectUri(deps));
    const [pages, scopes] = await Promise.all([graph.pages(userToken), graph.grantedScopes(userToken)]);
    if (!pages.length) return backTo(st.return_url, "err=fb_no_pages");
    const id = crypto.randomUUID();
    const key = await tokenKey(deps.tokenSecret!);
    await rpc(deps, "facebook_pending_save", {
      p_id: id,
      p_shop_id: st.shop_id,
      p_user_id: st.user_id,
      p_pages_enc: await encryptToken(key, JSON.stringify(pages), pendingBind(id)),
      p_return_url: st.return_url,
      p_scopes: scopes.join(","),
    });
    return backTo(st.return_url, `fb_pick=${id}`);
  } catch (e) {
    console.error("shop-blog: login failed", e instanceof FacebookError ? `code ${e.code}` : failText(e).slice(0, 120));
    return backTo(st.return_url, "err=fb_failed");
  }
}

async function pendingPages(deps: Deps, pendingId: string, userId: string, take: boolean) {
  if (!UUID.test(pendingId)) return null;
  const row = await rpc<{ shop_id: string; pages_enc: string; return_url: string; scopes: string | null } | null>(deps, "facebook_pending_get", {
    p_id: pendingId,
    p_user_id: userId,
    p_take: take,
  });
  if (!row || !deps.tokenSecret) return null;
  const pages = JSON.parse(await decryptToken(await tokenKey(deps.tokenSecret), row.pages_enc, pendingBind(pendingId))) as PageChoice[];
  return { ...row, pages };
}

async function ownerAction(action: string, req: Request, deps: Deps, body: Json): Promise<Response> {
  const who = await caller(req, deps);
  if (!who) return reply(401, { error: "login" });

  if (action === "admin_info") {
    const { data } = await deps.asCaller(who.authorization).rpc("is_admin");
    if (data !== true) return reply(403, { error: "admin" });
    const graph = deps.graph;
    return reply(200, {
      configured: facebookOn(deps),
      config_id: Boolean(graph?.config.configId),
      redirect_uri: redirectUri(deps),
      webhook_url: `${deps.functionUrl}/webhook`,
      verify_token: graph ? await webhookVerifyToken(graph.config.appSecret) : null,
      scopes: SCOPES,
    });
  }

  if (action === "photo_begin") {
    const post = await ownPost(deps, who.authorization, String(body.post_id ?? ""));
    if (!post) return reply(403, { error: "not_member" });
    if (post.source !== "cacaduu") return reply(400, { error: "imported" });
    const { data, error } = await deps.db.rpc("blog_photo_add", { p_post_id: post.id, p_status: "uploading" });
    if (error) return reply(error.message === "photo_limit" ? 409 : 500, { error: error.message === "photo_limit" ? "photo_limit" : "failed" });
    return reply(200, { photo_id: data });
  }

  if (action === "photo_delete") {
    const id = String(body.photo_id ?? "");
    if (!UUID.test(id)) return reply(400, { error: "bad_request" });
    const { data: photo } = await deps.db.from("blog_photos").select("id, post_id").eq("id", id).maybeSingle();
    if (!photo || !(await ownPost(deps, who.authorization, String((photo as { post_id: string }).post_id)))) return reply(403, { error: "not_member" });
    await removeFiles(deps, await rpc<string[]>(deps, "blog_photo_delete", { p_photo_id: id }));
    return reply(200, { deleted: true });
  }

  if (action === "post_delete") {
    const post = await ownPost(deps, who.authorization, String(body.post_id ?? ""));
    if (!post) return reply(403, { error: "not_member" });
    await removeFiles(deps, await rpc<string[]>(deps, "blog_post_files", { p_post_id: post.id }));
    return reply(200, { deleted: await rpc<boolean>(deps, "blog_post_remove", { p_post_id: post.id }) });
  }

  if (action === "publish_fb") {
    const post = await ownPost(deps, who.authorization, String(body.post_id ?? ""));
    if (!post) return reply(403, { error: "not_member" });
    if (!facebookOn(deps)) return reply(503, { error: "not_configured" });
    const result = await publishToFacebook(deps, post.id, body.retry === true);
    if (result.error === "not_waiting") return reply(409, { error: "published" });
    return reply(200, result);
  }

  if (action === "pages" || action === "pick") {
    if (!facebookOn(deps)) return reply(503, { error: "not_configured" });
    const pending = await pendingPages(deps, String(body.pending_id ?? ""), who.userId, false);
    if (!pending || !(await member(deps, who.authorization, pending.shop_id))) return reply(404, { error: "expired" });
    if (action === "pages") {
      return reply(200, { shop_id: pending.shop_id, pages: pending.pages.map(({ id, name, picture }) => ({ id, name, picture })) });
    }
    const page = pending.pages.find((p) => p.id === String(body.page_id ?? ""));
    if (!page) return reply(400, { error: "bad_request" });
    await pendingPages(deps, String(body.pending_id), who.userId, true);
    const key = await tokenKey(deps.tokenSecret!);
    let site: string | null = null;
    try {
      site = new URL(pending.return_url).origin;
    } catch {
      site = null;
    }
    await rpc(deps, "facebook_connection_save", {
      p_shop_id: pending.shop_id,
      p_page_id: page.id,
      p_page_name: page.name,
      p_page_picture: page.picture,
      p_token_enc: await encryptToken(key, page.token, pageBind(pending.shop_id, page.id)),
      p_scopes: pending.scopes,
      p_user_id: who.userId,
      p_site_url: site,
    });
    // Page feed changes to the webhook, where the Page allowed it (pages_manage_metadata); else the daily sync.
    if ((pending.scopes ?? "").split(",").includes("pages_manage_metadata")) {
      deps.background(deps.graph!.subscribe(page.token, page.id).catch(() => {}));
    }
    return reply(200, { page_name: page.name });
  }

  const shopId = String(body.shop_id ?? "");
  if (!(await member(deps, who.authorization, shopId))) return reply(403, { error: "not_member" });

  if (action === "connect") {
    if (!facebookOn(deps)) return reply(503, { error: "not_configured" });
    const returnUrl = String(body.return_url ?? "");
    if (!RETURN_URL.test(returnUrl) || returnUrl.length > 500) return reply(400, { error: "bad_request" });
    const state = b64url(random(32));
    await rpc(deps, "facebook_state_save", { p_state_hash: await sha256Hex(state), p_shop_id: shopId, p_user_id: who.userId, p_return_url: returnUrl });
    return reply(200, { url: deps.graph!.loginUrl(state, redirectUri(deps)) });
  }

  if (action === "disconnect") {
    return reply(200, { disconnected: await rpc<boolean>(deps, "facebook_disconnect", { p_shop_id: shopId }) });
  }

  if (action === "import") {
    if (!facebookOn(deps)) return reply(503, { error: "not_configured" });
    const started = await rpc<boolean>(deps, "facebook_import_start", { p_shop_id: shopId });
    if (started) next(deps, { action: "work", kind: "import", shop_id: shopId });
    return reply(200, { started });
  }

  return reply(400, { error: "bad_request" });
}

/** POST ?action=photo&photo_id=&size=: one size of the owner's photo, checked by its bytes. */
async function ownerPhoto(req: Request, deps: Deps, url: URL): Promise<Response> {
  const who = await caller(req, deps);
  if (!who) return reply(401, { error: "login" });
  const id = url.searchParams.get("photo_id") ?? "";
  const size = Number(url.searchParams.get("size"));
  if (!UUID.test(id) || (size !== 1600 && size !== 800)) return reply(400, { error: "bad_request" });
  const { data } = await deps.db.from("blog_photos").select("id, post_id, shop_id, status").eq("id", id).maybeSingle();
  const photo = data as { id: string; post_id: string; shop_id: string; status: string } | null;
  if (!photo || photo.status !== "uploading" || !(await ownPost(deps, who.authorization, photo.post_id))) return reply(403, { error: "not_member" });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_PHOTO_BYTES) return reply(413, { error: "too_big" });
  const info = sniffPicture(bytes);
  if (!info || info.width < 1 || info.height < 1 || info.width > size || info.height > 10_000) return reply(400, { error: "picture" });
  const path = `${photo.shop_id}/${photo.post_id}/${photo.id}-${size}.${info.type}`;
  await deps.storage.put(path, bytes, info.type === "webp" ? "image/webp" : "image/jpeg");
  await rpc(deps, "blog_photo_stored", {
    p_photo_id: photo.id, p_size: size, p_path: path, p_ext: info.type, p_width: info.width, p_height: info.height,
    // a small picture has one size only
    p_last: size === 800 || info.width <= 800,
  });
  return reply(200, { stored: size, width: info.width, height: info.height });
}

// ---------------------------------------------------------------- the webhook

export async function webhookVerifyToken(appSecret: string): Promise<string> {
  return (await hmacHex(appSecret, "ppi-shop-blog-webhook")).slice(0, 32);
}

async function webhook(req: Request, deps: Deps): Promise<Response> {
  const graph = deps.graph;
  if (!graph) return new Response("not configured", { status: 404 });
  const url = new URL(req.url);
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" &&
      sameSecret(url.searchParams.get("hub.verify_token"), await webhookVerifyToken(graph.config.appSecret));
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const raw = new Uint8Array(await req.arrayBuffer());
  const signature = (req.headers.get("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
  if (!sameSecret(signature, await hmacHex(graph.config.appSecret, raw))) return new Response("signature", { status: 401 });
  let body: { object?: string; entry?: { id?: string; changes?: { field?: string }[] }[] } = {};
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("ok", { status: 200 });
  }
  if (body.object === "page") {
    for (const entry of body.entry ?? []) {
      if (entry.id && FB_ID.test(String(entry.id)) && (entry.changes ?? []).some((c) => c.field === "feed")) {
        await deps.db.rpc("facebook_sync_page_soon", { p_page_id: String(entry.id) });
      }
    }
  }
  return new Response("ok", { status: 200 });
}

// ---------------------------------------------------------------- the entry point

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (/\/oauth\/?$/.test(url.pathname)) {
    if (req.method !== "GET") return reply(405, { error: "method" });
    return await callback(req, deps);
  }
  if (/\/webhook\/?$/.test(url.pathname)) return await webhook(req, deps);
  if (req.method !== "POST") return reply(405, { error: "method" });
  if (url.searchParams.get("action") === "photo") {
    try {
      return await ownerPhoto(req, deps, url);
    } catch (e) {
      console.error("shop-blog: photo upload", failText(e).slice(0, 160));
      return reply(500, { error: "failed" });
    }
  }

  let body: Json;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return reply(400, { error: "bad_request" });
  }
  const action = String(body?.action ?? "");
  try {
    if (action === "config") return reply(200, { facebook: facebookOn(deps) });
    const cron = req.headers.get("x-ppi-cron");
    if (cron !== null) {
      const { data: ok } = await deps.db.rpc("assistant_cron_ok", { p_secret: cron });
      if (ok !== true) return reply(401, { error: "secret" });
      if (action !== "tick") return reply(400, { error: "bad_request" });
      return reply(200, await tick(deps));
    }
    if (action === "work") {
      const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!sameSecret(bearer, deps.serviceKey)) return reply(401, { error: "secret" });
      if (body.kind === "import") {
        const shopId = String(body.shop_id ?? "");
        if (!UUID.test(shopId)) return reply(400, { error: "bad_request" });
        return reply(200, { import: await importStep(deps, shopId) });
      }
      if (body.kind === "photo") return reply(200, { photo: await photoStep(deps, typeof body.photo_id === "string" ? body.photo_id : null) });
      return reply(400, { error: "bad_request" });
    }
    return await ownerAction(action, req, deps, body);
  } catch (e) {
    console.error("shop-blog:", action, failText(e).slice(0, 160));
    return reply(500, { error: "failed" });
  }
}

export async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "config" });
  const env = (name: string) => Deno.env.get(name)?.trim() || null;
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const db = createClient(url, serviceKey, options);
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const base = url.replace(/\/+$/, "");
  const appId = env("FACEBOOK_APP_ID");
  const appSecret = env("FACEBOOK_APP_SECRET");
  const brevo = env("BREVO_API_KEY");
  const from = env("ALERT_EMAIL_FROM");
  return await handle(req, {
    db,
    asCaller: (authorization) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } }),
    graph: appId && appSecret ? new Graph({ appId, appSecret, configId: env("FACEBOOK_CONFIG_ID") }, fetch) : null,
    tokenSecret: env("FB_TOKEN_ENCRYPTION_KEY"),
    serviceKey,
    functionUrl: `${base}/functions/v1/shop-blog`,
    publicBase: `${base}/storage/v1/object/public/${BUCKET}/`,
    siteUrl: env("SITE_URL"),
    indexNowKey: env("INDEXNOW_KEY"),
    indexNowEndpoint: INDEXNOW_ENDPOINT,
    email: brevo && from ? { apiKey: brevo, from } : null,
    storage: {
      put: async (path, bytes, type) => {
        const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: true, cacheControl: "31536000" });
        if (error) throw new Error(`storage: ${error.message}`);
      },
      get: async (path) => {
        const { data } = await db.storage.from(BUCKET).download(path);
        return data ? new Uint8Array(await data.arrayBuffer()) : null;
      },
      remove: async (paths) => {
        for (let i = 0; i < paths.length; i += 100) await db.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      },
    },
    images: wasmImages,
    mediaHosts: MEDIA_HOSTS,
    fetch,
    chain: async (body) => {
      const res = await fetch(`${base}/functions/v1/shop-blog`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      await res?.body?.cancel().catch(() => {});
    },
    background: (task) => (runtime ? runtime.waitUntil(task) : void task),
    now: () => Date.now(),
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
