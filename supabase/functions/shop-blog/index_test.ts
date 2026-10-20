// Unit tests of shop-blog against an in-memory Facebook (Graph API), database and bucket: titles, what a post keeps
// (photos, videos as a link, links; never comments, reactions or names), the import page by page, photos as WebP,
// the daily sync (edited, deleted → hidden), publishing to the Page and its retry, never twice, the expired
// connection and its e-mail, no Facebook without its secrets, the login and the Page choice, the webhook, IndexNow.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  ALERT_SUBJECT,
  alertText,
  blogIndexNowUrls,
  blogPostUrl,
  decryptToken,
  type Deps,
  encryptToken,
  facebookMessage,
  type FbPost,
  Graph,
  handle,
  hmacHex,
  importTitle,
  mapPost,
  mediaAllowed,
  ownSlugIn,
  POST_FIELDS,
  publishToFacebook,
  shrink,
  sniffPicture,
  syncShop,
  tick,
  tokenKey,
  webhookVerifyToken,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const POST = "22222222-2222-4333-8444-555555555555";
const OWNER = "33333333-2222-4333-8444-555555555555";
const STRANGER = "44444444-2222-4333-8444-555555555555";
const PAGE = "1234567890";
const SECRET = "fb-token-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const SERVICE_KEY = "service-role-key-0123456789abcdefghijklmnop";
const CRON = "cron-secret-0123456789abcdef0123456789abcdef";
const APP = { appId: "4242", appSecret: "app-secret-0123456789abcdefghij", configId: null as string | null };
const CDN = "https://scontent.test.fbcdn.net";
/** The first bytes of a JPEG: a 2048 × 1536 photo (as Facebook keeps them) and an 8 × 6 one. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x06, 0x00, 0x08, 0x00, 3, 1, 1, 1, 0, 0, 0, 0, 0]);
const SMALL_JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x00, 0x06, 0x00, 0x08, 3, 1, 1, 1, 0, 0, 0, 0, 0]);
const enc = new TextEncoder();

// ---------------------------------------------------------------- texts

Deno.test("Imported titles: the first sentence, at most 70 characters cut at a word; else a link's title or the date", () => {
  eq(importTitle("Otvárame v nedeľu! Príďte všetci.", null, null), "Otvárame v nedeľu!", "first sentence");
  eq(importTitle("\n\n  Nová kolekcia jar 2026\nDruhý riadok", null, null), "Nová kolekcia jar 2026", "first line");
  const long = "Dnes máme výnimočne veľa čerstvého ovocia a zeleniny z našich miestnych fariem a od pestovateľov z okolia";
  const t = importTitle(long, null, null);
  assert([...t].length <= 70 && t.endsWith("…") && long.startsWith(t.slice(0, -1)), `cut at a word: ${t}`);
  assert(!t.slice(0, -1).endsWith(" "), "no space before …");
  eq(importTitle("", "Akcia týždňa", null), "Akcia týždňa", "a link's title");
  eq(importTitle("   ", null, "2026-10-12T08:30:00+0000"), "Facebook · 12. 10. 2026", "the date");
  eq(importTitle("#jahody 🍓 sú tu.", null, null), "#jahody 🍓 sú tu.", "as written, emoji and hashtags too");
  eq(importTitle("Novinka č. 10 z našej predajne. Príďte sa pozrieť!", null, null), "Novinka č. 10 z našej predajne.", "an abbreviation is no end");
  eq(importTitle("Otvorené 8.00 – 17.00 aj v sobotu", null, null), "Otvorené 8.00 – 17.00 aj v sobotu", "times are no end");
});

Deno.test("The Facebook message: the text as written and the last line 'Čítať na webe: <address>'", () => {
  eq(facebookMessage("Titul", "Text\n\nDruhý odsek  \n", "https://ppi.example/sk/shops/a/blog/b"), "Text\n\nDruhý odsek\n\nČítať na webe: https://ppi.example/sk/shops/a/blog/b", "text");
  eq(facebookMessage("Len titul", "  ", "https://x.sk/blog/b"), "Len titul\n\nČítať na webe: https://x.sk/blog/b", "no text: the title");
  eq(blogPostUrl({ siteUrl: "https://cacaduu.com/", host: null, country: "HU", shopSlug: "pek", postSlug: "uj" }), "https://cacaduu.com/hu/shops/pek/blog/uj", "on Cacaduu");
  eq(blogPostUrl({ siteUrl: "https://cacaduu.com", host: "davide.sk", country: "SK", shopSlug: "pek", postSlug: "uj" }), "https://davide.sk/blog/uj", "own domain");
  eq(ownSlugIn("Text\n\nČítať na webe: https://davide.sk/blog/nova-kolekcia"), "nova-kolekcia", "our own link");
  eq(ownSlugIn("Čítať na webe: https://cacaduu.com/sk/shops/x/blog/a-b-2 "), "a-b-2", "on Cacaduu");
  eq(ownSlugIn("Pozrite https://davide.sk/blog/nova"), null, "only our own last line");
  eq(ownSlugIn("Čítať na webe: https://davide.sk/blog/"), null, "no post");
});

Deno.test("A post keeps its text, photos, videos as picture + link, links and events; never profile pictures", () => {
  const post: FbPost = {
    id: "1234567890_111",
    message: "Nové tovary! #novinky\nPozrite www.example.com",
    created_time: "2026-10-12T08:30:00+0000",
    updated_time: "2026-10-12T09:00:00+0000",
    permalink_url: "https://www.facebook.com/1234567890/posts/111",
    attachments: {
      data: [
        {
          type: "album",
          subattachments: {
            data: [
              { type: "photo", target: { id: "501" }, media: { image: { src: `${CDN}/501.jpg`, width: 720, height: 540 } } },
              { type: "video_inline", url: "https://www.facebook.com/1234567890/videos/502", target: { id: "502" }, media: { image: { src: `${CDN}/502.jpg` } } },
            ],
          },
        },
        { type: "share", url: "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fakcia&h=x", title: "Akcia", description: "Zľava" },
        { type: "event", url: "https://www.facebook.com/events/77", title: "Ochutnávka" },
        { type: "profile_media", media: { image: { src: `${CDN}/me.jpg` } } },
      ],
    },
  };
  const m = mapPost(post)!;
  eq(m.message, post.message, "text exactly as written");
  eq(m.title, "Nové tovary!", "title");
  eq(m.media, [
    { kind: "photo", fb_media_id: "501", source_url: `${CDN}/501.jpg`, link_url: null },
    { kind: "video", fb_media_id: "502", source_url: `${CDN}/502.jpg`, link_url: "https://www.facebook.com/1234567890/videos/502" },
  ], "photos and the video's picture + link (the video is never downloaded)");
  eq(m.links, [
    { kind: "link", url: "https://example.com/akcia", title: "Akcia", description: "Zľava" },
    { kind: "event", url: "https://www.facebook.com/events/77", title: "Ochutnávka", description: null },
  ], "links unwrapped, events");
  eq(m.permalink, "https://www.facebook.com/1234567890/posts/111", "permalink");
  eq(mapPost({ id: "1_2", is_published: false, message: "naplánované" }), null, "not published: never");
  eq(mapPost({ id: "1_3", attachments: { data: [{ type: "cover_photo", media: { image: { src: `${CDN}/c.jpg` } } }] } }), null, "a new cover picture without words");
  eq(mapPost({ id: "../etc", message: "x" }), null, "a strange id");
  assert(mapPost({ id: "1_4", message: "x", permalink_url: "https://evil.example/x" })!.permalink === null, "only Facebook addresses as permalink");
});

Deno.test("What is asked from Facebook: the post's own content only — never comments, reactions or people", () => {
  for (const banned of ["comments", "reactions", "likes", "from", "to", "message_tags", "with_tags", "story_tags", "place", "shares", "admin_creator", "story"]) {
    assert(!POST_FIELDS.split(/[,{}]/).includes(banned), `never ${banned}`);
  }
});

Deno.test("Pictures: JPEG and WebP by their bytes; area-averaging makes them smaller, never larger", () => {
  eq(sniffPicture(JPEG), { type: "jpg", width: 2048, height: 1536 }, "jpeg");
  eq(sniffPicture(SMALL_JPEG), { type: "jpg", width: 8, height: 6 }, "a small one");
  const webp = Uint8Array.from([...enc.encode("RIFF"), 0, 0, 0, 0, ...enc.encode("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, 0x3f, 0x06, 0, 0x2b, 0x04, 0]);
  eq(sniffPicture(webp), { type: "webp", width: 1600, height: 1068 }, "webp");
  eq(sniffPicture(enc.encode("<svg></svg>")), null, "anything else");
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data.set(i % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
  const half = shrink({ data, width: 4, height: 4 }, 2);
  eq([half.width, half.height], [2, 2], "half");
  assert(half.data.every((v, i) => (i % 4 === 3 ? v === 255 : Math.abs(v - 127.5) <= 1)), "the mean of the pixels it covers");
  eq(shrink({ data, width: 4, height: 4 }, 8).width, 4, "never larger");
  assert(mediaAllowed(`${CDN}/a.jpg`, [".fbcdn.net"]) && !mediaAllowed("https://evil.example/a.jpg", [".fbcdn.net"]), "Facebook's hosts only");
  assert(!mediaAllowed("http://scontent.test.fbcdn.net/a.jpg", [".fbcdn.net"]), "https only");
});

Deno.test("The Page token is encrypted, bound to its shop and Page", async () => {
  const key = await tokenKey(SECRET);
  const sealed = await encryptToken(key, "EAAB-page-token", `${SHOP}:${PAGE}:page`);
  assert(!sealed.includes("EAAB"), "not readable");
  eq(await decryptToken(key, sealed, `${SHOP}:${PAGE}:page`), "EAAB-page-token", "opens");
  let refused = false;
  await decryptToken(key, sealed, `${SHOP}:999:page`).catch(() => (refused = true));
  assert(refused, "another Page's row");
});

// ---------------------------------------------------------------- the stand-ins

interface Row {
  fb_post_id: string;
  message: string;
  title: string;
  media: unknown;
  hidden: boolean;
  source: "facebook" | "cacaduu";
}

function fbPost(n: number, extra: Partial<FbPost> = {}): FbPost {
  return {
    id: `${PAGE}_${n}`,
    message: `Príspevok ${n}. Text.`,
    created_time: new Date(Date.UTC(2026, 9, 1) + n * 3600_000).toISOString(),
    updated_time: new Date(Date.UTC(2026, 9, 1) + n * 3600_000).toISOString(),
    permalink_url: `https://www.facebook.com/${PAGE}/posts/${n}`,
    ...(n % 5 === 0
      ? { attachments: { data: [{ type: "photo", target: { id: String(9000 + n) }, media: { image: { src: `${CDN}/${n}-720.jpg`, width: 720 } } }] } }
      : {}),
    ...extra,
  };
}

function world(o: { facebook?: boolean; posts?: FbPost[]; expired?: boolean } = {}) {
  const log: string[] = [];
  const graphCalls: URL[] = [];
  const tasks: Promise<unknown>[] = [];
  const chained: Record<string, unknown>[] = [];
  const files = new Map<string, Uint8Array>();
  const rows = new Map<string, Row>(); // fb_post_id → imported post
  const fb = {
    posts: o.posts ?? Array.from({ length: 55 }, (_, i) => fbPost(55 - i)), // newest first
    deleted: new Set<string>(),
    published: [] as { message: string; attached: string | null; link: string | null }[],
    uploads: [] as string[],
    expired: Boolean(o.expired),
    failPublish: 0,
    pages: [{ id: PAGE, name: "Potraviny Centrum", access_token: "EAAB-page-token", picture: { data: { url: `${CDN}/page.jpg` } } }],
  };
  const conn = {
    value: null as null | Record<string, unknown>,
  };
  let importCursor: string | null = "";
  let fbClaim: Record<string, unknown> | null = null;
  const pending = new Map<string, Record<string, unknown>>();
  const states = new Map<string, Record<string, unknown>>();
  const photos = new Map<string, Record<string, unknown>>();
  const alerts: Record<string, unknown>[] = [];
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const fbError = (code: number, subcode?: number, status = 400) => json(status, { error: { message: `err ${code}`, type: "OAuthException", code, error_subcode: subcode } });

  async function graph(req: Request, url: URL): Promise<Response> {
    graphCalls.push(url);
    const params = req.method === "GET" ? url.searchParams : new URLSearchParams(await req.text());
    const token = params.get("access_token");
    if (token && params.get("appsecret_proof") !== (await hmacHex(APP.appSecret, token))) return fbError(100);
    const path = url.pathname.replace("/v23.0/", "").replace(/^\//, "");
    if (path === "oauth/access_token") {
      if (params.get("client_secret") !== APP.appSecret) return fbError(1);
      if (params.get("code") === "good-code") return json(200, { access_token: "user-short" });
      if (params.get("fb_exchange_token") === "user-short") return json(200, { access_token: "user-long" });
      return fbError(100);
    }
    if (token && token !== "EAAB-page-token" && token !== "user-long") return fbError(190);
    if (fb.expired) return fbError(190, 463);
    if (path === "me/accounts") return json(200, { data: fb.pages });
    if (path === "me/permissions") {
      return json(200, { data: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"].map((permission) => ({ permission, status: "granted" })) });
    }
    if (path === PAGE) return json(200, { name: "Potraviny Centrum", picture: { data: { url: `${CDN}/page2.jpg` } } });
    if (path === `${PAGE}/posts`) {
      const all = fb.posts.filter((p) => !fb.deleted.has(p.id)).filter((p) => !params.get("since") || Date.parse(p.created_time!) / 1000 >= Number(params.get("since")));
      const from = Number(params.get("after") || 0);
      const limit = Number(params.get("limit"));
      const data = all.slice(from, from + limit);
      const more = from + limit < all.length;
      return json(200, { data, paging: { cursors: { after: String(from + limit) }, ...(more ? { next: "https://graph.facebook.com/next" } : {}) } });
    }
    if (path === "" && req.method === "POST") {
      const batch = JSON.parse(params.get("batch")!) as { relative_url: string }[];
      return json(200, batch.map((b) => {
        const id = b.relative_url.split("?")[0];
        const post = fb.posts.find((p) => p.id === id);
        return !post || fb.deleted.has(id)
          ? { code: 400, body: JSON.stringify({ error: { message: "does not exist", code: 100, error_subcode: 33 } }) }
          : { code: 200, body: JSON.stringify(post) };
      }));
    }
    if (/^9\d{3}$/.test(path)) {
      return json(200, { images: [{ width: 2048, height: 1536, source: `${CDN}/${path}-2048.jpg` }, { width: 720, height: 540, source: `${CDN}/${path}-720.jpg` }] });
    }
    if (path === `${PAGE}/photos` && req.method === "POST") {
      assert(params.get("published") === "false", "photos first unpublished, then attached");
      fb.uploads.push(params.get("url")!);
      return json(200, { id: String(7000 + fb.uploads.length) });
    }
    if (path === `${PAGE}/feed` && req.method === "POST") {
      if (fb.failPublish > 0) {
        fb.failPublish--;
        return fbError(368);
      }
      fb.published.push({ message: params.get("message")!, attached: params.get("attached_media"), link: params.get("link") });
      return json(200, { id: `${PAGE}_${800 + fb.published.length}` });
    }
    if (/^1234567890_8\d\d$/.test(path)) return json(200, { permalink_url: `https://www.facebook.com/${PAGE}/posts/${path.split("_")[1]}` });
    return fbError(100, undefined, 404);
  }

  const doFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "graph.facebook.com") return await graph(req, url);
    if (url.hostname === "scontent.test.fbcdn.net") {
      log.push(`download ${url.pathname}`);
      return new Response(JPEG as BodyInit, { status: 200 });
    }
    if (url.hostname === "api.brevo.com") {
      log.push(`email ${(await req.json()).subject}`);
      return json(201, { messageId: "1" });
    }
    if (url.hostname === "indexnow.test") {
      log.push(`indexnow ${JSON.stringify(await req.json())}`);
      return new Response(null, { status: 202 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const ok = (data: unknown) => ({ data, error: null });
  const rpc = (name: string, args: Record<string, unknown>) => {
    log.push(`rpc ${name}`);
    switch (name) {
      case "assistant_cron_ok":
        return ok(args.p_secret === CRON);
      case "facebook_connection_of":
        return ok(conn.value);
      case "facebook_import_take":
        return ok(importCursor === null ? null : { cursor: importCursor });
      case "facebook_import_step":
        log.push(`step ${args.p_cursor} +${args.p_count}${args.p_error ? ` ${args.p_error}` : ""}`);
        importCursor = (args.p_cursor as string | null) ?? null;
        return ok(null);
      case "facebook_import_start":
        importCursor = "";
        return ok(true);
      case "blog_import_post": {
        const id = String(args.p_fb_post_id);
        const old = rows.get(id);
        if (old?.source === "cacaduu") return ok({ result: "own", removed: [] });
        if (old) {
          if (old.message === args.p_message && JSON.stringify(old.media) === JSON.stringify(args.p_media)) return ok({ result: "same", removed: [] });
          old.message = String(args.p_message);
          return ok({ result: "updated", removed: [`${SHOP}/${POST}/old-1600.webp`] });
        }
        rows.set(id, { fb_post_id: id, message: String(args.p_message), title: String(args.p_title), media: args.p_media, hidden: false, source: "facebook" });
        for (const m of args.p_media as { fb_media_id: string; source_url: string; kind: string }[]) {
          const pid = crypto.randomUUID();
          photos.set(pid, { id: pid, post_id: POST, shop_id: SHOP, fb_media_id: m.fb_media_id, source_url: m.source_url, kind: m.kind, path_large: null, path_small: null, status: "pending" });
        }
        return ok({ result: "new", removed: [] });
      }
      case "facebook_newest_import":
        return ok(rows.size ? "2026-10-01T00:00:00Z" : null);
      case "blog_posts_to_check":
        return ok([...rows.values()].filter((r) => r.source === "facebook" && !r.hidden).map((r) => ({ post_id: POST, fb_post_id: r.fb_post_id })));
      case "blog_posts_deleted_on_facebook": {
        for (const id of args.p_fb_post_ids as string[]) rows.get(id)!.hidden = true;
        return ok((args.p_fb_post_ids as string[]).length);
      }
      case "blog_posts_checked":
      case "facebook_sync_done":
      case "facebook_alert_sent":
      case "blog_stale_uploads":
      case "facebook_sync_page_soon":
        log.push(`${name} ${JSON.stringify(args)}`);
        return ok(null);
      case "blog_orphan_files":
        return ok([]);
      case "facebook_connection_result":
        log.push(`connection ${args.p_expired ? "expired" : "ok"}`);
        if (args.p_expired && conn.value) conn.value.status = "expired";
        return ok(null);
      case "blog_photos_due": {
        const due = [...photos.values()].find((p) => p.status === "pending");
        return ok(due ? [due] : []);
      }
      case "blog_photo_stored": {
        const p = photos.get(String(args.p_photo_id))!;
        if (args.p_size === 1600) p.path_large = args.p_path;
        else p.path_small = args.p_path;
        if (args.p_last) p.status = "ready";
        log.push(`stored ${args.p_size} ${args.p_width}${args.p_last ? " last" : ""}`);
        return ok(null);
      }
      case "blog_photo_failed":
        log.push(`photo failed ${args.p_error}`);
        return ok(null);
      case "blog_fb_due":
        return ok(fbClaim ? [POST] : []);
      case "blog_fb_claim": {
        const c = fbClaim;
        if (!c || (c.state !== "waiting" && !(args.p_retry && c.state === "failed"))) return ok(null);
        c.state = "posting";
        return ok(c);
      }
      case "blog_fb_result":
        fbClaim!.state = args.p_fb_post_id ? "posted" : "failed";
        log.push(`fb result ${args.p_fb_post_id ?? args.p_error}`);
        if (args.p_fb_post_id) rows.set(String(args.p_fb_post_id), { fb_post_id: String(args.p_fb_post_id), message: "", title: "", media: [], hidden: false, source: "cacaduu" });
        return ok(null);
      case "shop_site":
        return ok(null);
      case "facebook_alerts_due":
        return ok(alerts.splice(0));
      case "facebook_state_save":
        states.set(String(args.p_state_hash), { shop_id: args.p_shop_id, user_id: args.p_user_id, return_url: args.p_return_url });
        return ok(null);
      case "facebook_state_take": {
        const st = states.get(String(args.p_state_hash)) ?? null;
        states.delete(String(args.p_state_hash));
        return ok(st);
      }
      case "facebook_pending_save":
        pending.set(String(args.p_id), { ...args });
        return ok(null);
      case "facebook_pending_get": {
        const p = pending.get(String(args.p_id));
        if (!p || p.p_user_id !== args.p_user_id) return ok(null);
        if (args.p_take) pending.delete(String(args.p_id));
        return ok({ shop_id: p.p_shop_id, pages_enc: p.p_pages_enc, return_url: p.p_return_url, scopes: p.p_scopes });
      }
      case "facebook_connection_save":
        conn.value = { shop_id: args.p_shop_id, page_id: args.p_page_id, page_name: args.p_page_name, page_token_enc: args.p_token_enc, status: "ok", connected_at: "2026-09-01T00:00:00Z", shop_slug: "potraviny-centrum", shop_country: "SK" };
        log.push(`connection saved ${String(args.p_token_enc).slice(0, 3)}`);
        return ok(null);
      case "blog_indexnow_claim":
      case "facebook_import_start_unused":
        return ok(null);
      case "facebook_imports_stalled":
      case "facebook_sync_due":
        return ok([]);
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  };
  const selectChain = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (k: string, v: unknown) => ((filters[k] = v), chain),
      lte: () => chain,
      limit: () => Promise.resolve(ok([...photos.values()].filter((p) => p.status === "pending").slice(0, 1))),
      maybeSingle: () => {
        assert(table === "blog_photos", `select from ${table}`);
        const p = photos.get(String(filters.id));
        return Promise.resolve(ok(p && (!filters.status || p.status === filters.status) ? p : null));
      },
    };
    return chain;
  };
  const db = { rpc: (n: string, a: Record<string, unknown> = {}) => Promise.resolve(rpc(n, a)), from: selectChain } as unknown as SupabaseClient;
  const asCaller = (authorization: string) => {
    const user = authorization === "Bearer owner" ? OWNER : authorization === "Bearer stranger" ? STRANGER : null;
    return {
      auth: { getUser: () => Promise.resolve({ data: { user: user ? { id: user } : null } }) },
      rpc: (name: string, args: Record<string, unknown>) => {
        if (name === "is_shop_member") return Promise.resolve(ok(user === OWNER && args.p_shop_id === SHOP));
        if (name === "is_admin") return Promise.resolve(ok(false));
        if (name === "owner_blog_post") {
          return Promise.resolve(user === OWNER ? ok({ id: args.p_post_id, shop_id: SHOP, source: "cacaduu", status: "published" }) : { data: null, error: { message: "Not your shop" } });
        }
        throw new Error(`unexpected caller rpc ${name}`);
      },
    } as unknown as SupabaseClient;
  };
  const deps: Deps = {
    db,
    asCaller,
    graph: o.facebook === false ? null : new Graph(APP, doFetch),
    tokenSecret: o.facebook === false ? null : SECRET,
    serviceKey: SERVICE_KEY,
    functionUrl: "https://proj.supabase.co/functions/v1/shop-blog",
    publicBase: "https://proj.supabase.co/storage/v1/object/public/blog-photos/",
    siteUrl: "https://cacaduu.test",
    indexNowKey: "c0ffee00c0ffee00",
    indexNowEndpoint: "https://indexnow.test/indexnow",
    email: { apiKey: "brevo", from: "ppi@example.invalid" },
    storage: {
      put: (path, bytes) => (files.set(path, bytes), Promise.resolve()),
      get: (path) => Promise.resolve(files.get(path) ?? null),
      remove: (paths) => (paths.forEach((p) => (files.delete(p), log.push(`remove ${p}`))), Promise.resolve()),
    },
    images: {
      webp: (bytes, width) => {
        assert(sniffPicture(bytes) || new TextDecoder().decode(bytes).startsWith("webp-"), "a picture");
        const w = Math.min(width, 2048);
        return Promise.resolve({ bytes: enc.encode(`webp-${w}`), width: w, height: Math.round((w * 3) / 4) });
      },
    },
    mediaHosts: [".fbcdn.net"],
    fetch: doFetch as typeof fetch,
    chain: (body) => (chained.push(body), Promise.resolve()),
    background: (task) => void tasks.push(task),
    now: () => Date.now(),
  };
  const connect = async () => {
    const key = await tokenKey(SECRET);
    conn.value = {
      shop_id: SHOP, page_id: PAGE, page_name: "Potraviny Centrum", status: "ok", connected_at: "2026-09-01T00:00:00Z",
      page_token_enc: await encryptToken(key, "EAAB-page-token", `${SHOP}:${PAGE}:page`), shop_slug: "potraviny-centrum", shop_country: "SK",
    };
  };
  return {
    deps, log, graphCalls, chained, files, rows, fb, photos, alerts, connect, conn,
    setClaim: (c: Record<string, unknown> | null) => (fbClaim = c),
    claim: () => fbClaim,
    stopImport: () => (importCursor = null),
  };
}

const post = (deps: Deps, body: unknown, auth = "Bearer owner", headers: Record<string, string> = {}) =>
  handle(new Request("https://proj.supabase.co/functions/v1/shop-blog", { method: "POST", headers: { Authorization: auth, ...headers }, body: JSON.stringify(body) }), deps);

// ---------------------------------------------------------------- import, photos, sync

Deno.test("Import of all past posts: page by page, each call one page, the next one chained; photos queued", async () => {
  const w = world();
  await w.connect();
  for (let call = 0; call < 3; call++) {
    const res = await post(w.deps, { action: "work", kind: "import", shop_id: SHOP }, `Bearer ${SERVICE_KEY}`);
    eq(res.status, 200, "work");
  }
  eq(w.log.filter((l) => l.startsWith("step")), ["step 25 +25", "step 50 +25", "step null +5"], "25 + 25 + 5, then done");
  eq(w.rows.size, 55, "every post once");
  eq(w.chained.filter((c) => c.kind === "import").length, 2, "the next page in a new call, twice");
  assert(w.chained.some((c) => c.kind === "photo"), "the photos follow");
  eq(w.photos.size, 11, "every 5th post has a photo");
  // never asked for comments or reactions; every call with appsecret_proof
  for (const u of w.graphCalls) {
    assert(!/comments|reactions|likes/.test(u.search), `never comments: ${u}`);
    if (u.searchParams.get("access_token")) assert(u.searchParams.get("appsecret_proof"), "appsecret_proof");
  }
  // the work call needs the service key
  eq((await post(w.deps, { action: "work", kind: "import", shop_id: SHOP }, "Bearer owner")).status, 401, "not for owners");
});

Deno.test("Imported photos: Facebook's largest picture → WebP 1600, then 800 from it; failures are noted", async () => {
  const w = world({ posts: [fbPost(5), fbPost(10)] });
  await w.connect();
  w.deps.chain = (body) => (w.chained.push(body), Promise.resolve());
  await post(w.deps, { action: "work", kind: "import", shop_id: SHOP }, `Bearer ${SERVICE_KEY}`);
  const first = [...w.photos.values()][0];
  await post(w.deps, { action: "work", kind: "photo" }, `Bearer ${SERVICE_KEY}`);
  assert(w.log.includes("download /9005-2048.jpg") || w.log.includes("download /9010-2048.jpg"), "the 2048 px picture, not the post's 720 px one");
  assert(w.log.includes("stored 1600 1600"), "1600 first");
  const chainedOne = w.chained.find((c) => c.kind === "photo" && c.photo_id);
  assert(chainedOne, "the 800 px one in the next call");
  await post(w.deps, chainedOne, `Bearer ${SERVICE_KEY}`);
  assert(w.log.includes("stored 800 800 last"), "then 800, from the stored 1600");
  const done = [...w.photos.values()].find((p) => p.status === "ready")!;
  assert(String(done.path_large).endsWith("-1600.webp") && String(done.path_small).endsWith("-800.webp"), "both sizes in WebP");
  assert(w.files.get(String(done.path_small)), "stored in the bucket");
  assert(first, "a photo");
  // a picture from elsewhere is never downloaded
  const bad = [...w.photos.values()].find((p) => p.status === "pending")!;
  bad.fb_media_id = null;
  bad.source_url = "https://evil.example/x.jpg";
  await post(w.deps, { action: "work", kind: "photo", photo_id: bad.id }, `Bearer ${SERVICE_KEY}`);
  assert(w.log.some((l) => l.startsWith("photo failed not a Facebook picture address")), "refused");
});

Deno.test("Daily sync: new posts since the newest import, edited updated, deleted on Facebook hidden", async () => {
  const w = world({ posts: [fbPost(3), fbPost(2), fbPost(1)] });
  await w.connect();
  await post(w.deps, { action: "work", kind: "import", shop_id: SHOP }, `Bearer ${SERVICE_KEY}`);
  eq(w.rows.size, 3, "imported");
  w.fb.posts.unshift(fbPost(4));
  w.fb.posts.find((p) => p.id === `${PAGE}_2`)!.message = "Príspevok 2 upravený.";
  w.fb.deleted.add(`${PAGE}_1`);
  const r = await syncShop(w.deps, SHOP);
  eq(r, { new: 1, updated: 1, deleted: 1 }, "one new, one edited, one gone");
  assert(w.rows.get(`${PAGE}_1`)!.hidden, "hidden here");
  eq(w.rows.get(`${PAGE}_2`)!.message, "Príspevok 2 upravený.", "the edit, as written");
  assert(w.log.some((l) => l.startsWith("facebook_sync_done") && l.includes("Potraviny Centrum")), "the Page's name refreshed");
  assert(w.log.includes(`remove ${SHOP}/${POST}/old-1600.webp`), "old photo files removed");
});

Deno.test("Before the first import, the sync takes only what was posted since the Page was connected", async () => {
  const w = world({ posts: [fbPost(1)] });
  await w.connect();
  w.conn.value!.connected_at = "2026-12-01T00:00:00Z";
  await syncShop(w.deps, SHOP);
  eq(w.rows.size, 0, "older posts only with 'Stiahnuť všetky príspevky'");
});

Deno.test("An expired connection: noted, the owner gets one e-mail; imported posts stay", async () => {
  const w = world({ posts: [fbPost(1)] });
  await w.connect();
  await post(w.deps, { action: "work", kind: "import", shop_id: SHOP }, `Bearer ${SERVICE_KEY}`);
  w.fb.expired = true;
  await syncShop(w.deps, SHOP);
  assert(w.log.includes("connection expired"), "expired");
  eq(w.conn.value!.status, "expired", "status");
  eq(w.rows.size, 1, "imported posts stay");
  w.alerts.push({ shop_id: SHOP, shop_name: "Potraviny Centrum", shop_slug: "potraviny-centrum", page_name: "Potraviny Centrum", site_url: "https://cacaduu.test", emails: ["a@example.invalid"] });
  const res = await post(w.deps, { action: "tick" }, "", { "x-ppi-cron": CRON });
  eq(res.status, 200, "tick");
  assert(w.log.includes(`email ${ALERT_SUBJECT}`), "the e-mail");
  assert(w.log.some((l) => l.startsWith("facebook_alert_sent")), "noted once");
  const text = alertText({ shop_id: SHOP, shop_name: "Obchod", shop_slug: "obchod", page_name: "Stránka", site_url: "https://cacaduu.test/", emails: [] });
  assert(text.includes("https://cacaduu.test/sk/dashboard/blog?shop=obchod#facebook") && text.includes("zostávajú"), text);
  eq((await post(w.deps, { action: "tick" }, "", { "x-ppi-cron": "wrong" })).status, 401, "the job's secret");
});

// ---------------------------------------------------------------- publishing

Deno.test("Publishing to the Page: photos unpublished then attached, the text + 'Čítať na webe', the id kept; retry; never twice", async () => {
  const w = world({ posts: [] });
  await w.connect();
  w.setClaim({ post_id: POST, shop_id: SHOP, shop_slug: "potraviny-centrum", shop_country: "SK", slug: "nova-kolekcia", title: "Nová kolekcia", body: "Text ako ho obchod napísal.", photos: [`${SHOP}/${POST}/a-1600.webp`, `${SHOP}/${POST}/b-1600.webp`], state: "waiting" });
  w.fb.failPublish = 1;
  const first = await post(w.deps, { action: "publish_fb", post_id: POST });
  const a = await first.json();
  assert(!a.ok && /^Facebook: /.test(a.error), `the reason: ${JSON.stringify(a)}`);
  eq(w.claim()!.state, "failed", "the web post stays, Facebook failed");
  // "Skúsiť znova na Facebook"
  const again = await (await post(w.deps, { action: "publish_fb", post_id: POST, retry: true })).json();
  eq(again, { ok: true, permalink: `https://www.facebook.com/${PAGE}/posts/801` }, "posted, with its address");
  eq(w.fb.published[0].message, "Text ako ho obchod napísal.\n\nČítať na webe: https://cacaduu.test/sk/shops/potraviny-centrum/blog/nova-kolekcia", "the message");
  eq(JSON.parse(w.fb.published[0].attached!), [{ media_fbid: "7003" }, { media_fbid: "7004" }], "the photos attached");
  assert(w.fb.uploads.every((u) => u.startsWith("https://proj.supabase.co/storage/v1/object/public/blog-photos/")), "from our public bucket");
  eq((await post(w.deps, { action: "publish_fb", post_id: POST, retry: true })).status, 409, "never twice");
  // the next import brings it back: the database says it is our own
  w.fb.posts.push({ id: `${PAGE}_801`, message: w.fb.published[0].message, created_time: new Date().toISOString() });
  w.stopImport();
  await post(w.deps, { action: "import", shop_id: SHOP });
  await post(w.deps, { action: "work", kind: "import", shop_id: SHOP }, `Bearer ${SERVICE_KEY}`);
  eq(w.rows.get(`${PAGE}_801`)!.source, "cacaduu", "no duplicate");
  // another shop's owner
  eq((await post(w.deps, { action: "publish_fb", post_id: POST }, "Bearer stranger")).status, 403, "not their post");
});

Deno.test("A scheduled 'Web + Facebook' post goes out with the job at its time", async () => {
  const w = world({ posts: [] });
  await w.connect();
  w.setClaim({ post_id: POST, shop_id: SHOP, shop_slug: "potraviny-centrum", shop_country: "SK", slug: "o-tyzden", title: "O týždeň", body: "", photos: [], state: "waiting" });
  await post(w.deps, { action: "tick" }, "", { "x-ppi-cron": CRON });
  eq(w.fb.published.length, 1, "posted by the job");
  eq(w.fb.published[0].message, "O týždeň\n\nČítať na webe: https://cacaduu.test/sk/shops/potraviny-centrum/blog/o-tyzden", "title when there is no text");
  eq(w.fb.published[0].link, "https://cacaduu.test/sk/shops/potraviny-centrum/blog/o-tyzden", "no photos: the link card");
});

Deno.test("Publishing with an expired connection: the reason, nothing posted", async () => {
  const w = world({ posts: [], expired: true });
  await w.connect();
  w.setClaim({ post_id: POST, shop_id: SHOP, shop_slug: "s", shop_country: "SK", slug: "p", title: "T", body: "B", photos: [], state: "waiting" });
  const r = await publishToFacebook(w.deps, POST, false);
  eq(r, { ok: false, error: "Pripojenie k Facebooku vypršalo – pripojte znova." }, "the owner's text");
  assert(w.log.includes("connection expired"), "the connection is marked");
});

// ---------------------------------------------------------------- no Facebook without its secrets

Deno.test("Without FACEBOOK_APP_ID / FACEBOOK_APP_SECRET: config says no, nothing Facebook works, no errors", async () => {
  const w = world({ facebook: false });
  eq(await (await post(w.deps, { action: "config" }, "")).json(), { facebook: false }, "config");
  eq((await post(w.deps, { action: "connect", shop_id: SHOP, return_url: "https://ppi.test/sk/dashboard/blog" })).status, 503, "connect");
  eq((await post(w.deps, { action: "import", shop_id: SHOP })).status, 503, "import");
  eq((await post(w.deps, { action: "tick" }, "", { "x-ppi-cron": CRON })).status, 200, "the job still runs (IndexNow, files)");
  const on = world();
  eq(await (await post(on.deps, { action: "config" }, "")).json(), { facebook: true }, "with them");
});

// ---------------------------------------------------------------- login and the Page choice

Deno.test("Connect: Facebook's login, back with the Pages to pick (encrypted, no token to the browser), the token stored encrypted", async () => {
  const w = world();
  eq((await post(w.deps, { action: "connect", shop_id: SHOP, return_url: "https://evil.example/" })).status, 400, "only back to Môj obchod");
  eq((await post(w.deps, { action: "connect", shop_id: SHOP, return_url: "https://ppi.test/sk/dashboard/blog" }, "Bearer stranger")).status, 403, "members only");
  const { url } = await (await post(w.deps, { action: "connect", shop_id: SHOP, return_url: "https://ppi.test/sk/dashboard/blog/new?shop=x" })).json();
  const login = new URL(url);
  eq(login.origin + login.pathname, "https://www.facebook.com/v23.0/dialog/oauth", "the login dialog");
  eq(login.searchParams.get("scope"), "pages_show_list,pages_read_engagement,pages_manage_posts", "only the needed permissions");
  eq(login.searchParams.get("redirect_uri"), "https://proj.supabase.co/functions/v1/shop-blog/oauth", "back to the function");
  const state = login.searchParams.get("state")!;
  const back = await handle(new Request(`https://proj.supabase.co/functions/v1/shop-blog/oauth?code=good-code&state=${state}`), w.deps);
  eq(back.status, 302, "back");
  const loc = new URL(back.headers.get("Location")!);
  eq(loc.pathname, "/sk/dashboard/blog/new", "to the editor it came from");
  const pick = loc.searchParams.get("fb_pick")!;
  assert(/^[0-9a-f-]{36}$/.test(pick) && loc.hash === "#facebook", "the choice");
  const again = await handle(new Request(`https://proj.supabase.co/functions/v1/shop-blog/oauth?code=good-code&state=${state}`), w.deps);
  eq(again.status, 400, "a state works once");
  const pages = await (await post(w.deps, { action: "pages", pending_id: pick })).json();
  eq(pages.pages, [{ id: PAGE, name: "Potraviny Centrum", picture: `${CDN}/page.jpg` }], "names and pictures, never tokens");
  eq((await post(w.deps, { action: "pages", pending_id: pick }, "Bearer stranger")).status, 404, "only whoever logged in");
  eq(await (await post(w.deps, { action: "pick", pending_id: pick, page_id: PAGE })).json(), { page_name: "Potraviny Centrum" }, "picked");
  assert(w.log.includes("connection saved v1."), "stored encrypted");
  eq(await decryptToken(await tokenKey(SECRET), String(w.conn.value!.page_token_enc), `${SHOP}:${PAGE}:page`), "EAAB-page-token", "the Page token");
  eq((await post(w.deps, { action: "pick", pending_id: pick, page_id: PAGE })).status, 404, "once");
  // no Pages (a personal profile only)
  w.fb.pages = [];
  const { url: url2 } = await (await post(w.deps, { action: "connect", shop_id: SHOP, return_url: "https://ppi.test/sk/dashboard/blog" })).json();
  const none = await handle(new Request(`https://proj.supabase.co/functions/v1/shop-blog/oauth?code=good-code&state=${new URL(url2).searchParams.get("state")}`), w.deps);
  eq(new URL(none.headers.get("Location")!).searchParams.get("err"), "fb_no_pages", "a personal profile is no Page");
  // Facebook Login for Business: the configuration instead of the scope list
  const business = new Graph({ ...APP, configId: "987" }, fetch).loginUrl("s", "https://x/oauth");
  assert(new URL(business).searchParams.get("config_id") === "987" && !new URL(business).searchParams.get("scope"), "config_id");
});

// ---------------------------------------------------------------- owner photos

Deno.test("The owner's photos: checked by their bytes and width, stored under the photo's own name", async () => {
  const w = world();
  const id = "55555555-2222-4333-8444-555555555555";
  w.photos.set(id, { id, post_id: POST, shop_id: SHOP, status: "uploading" });
  const send = (size: number, bytes: Uint8Array, auth = "Bearer owner") =>
    handle(new Request(`https://proj.supabase.co/functions/v1/shop-blog?action=photo&photo_id=${id}&size=${size}`, { method: "POST", headers: { Authorization: auth }, body: bytes as BodyInit }), w.deps);
  eq((await send(800, enc.encode("<svg/>"))).status, 400, "not a picture");
  eq((await send(800, SMALL_JPEG, "Bearer stranger")).status, 403, "not their photo");
  eq((await send(1600, JPEG)).status, 400, "2048 px is too wide: the browser makes it 1600");
  eq((await send(1600, SMALL_JPEG)).status, 200, "stored");
  eq([...w.files.keys()], [`${SHOP}/${POST}/${id}-1600.jpg`], "the path");
  assert(w.log.includes("stored 1600 8 last"), "a small picture has one size");
  const webp = Uint8Array.from([...enc.encode("RIFF"), 0, 0, 0, 0, ...enc.encode("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, 0x3f, 0x06, 0, 0x2b, 0x04, 0]);
  w.photos.get(id)!.status = "uploading";
  eq((await send(800, webp)).status, 400, "1600 px is too wide for the 800 slot");
});

// ---------------------------------------------------------------- webhook, IndexNow

Deno.test("Webhook: Meta's check with the verify token; changes only with the app secret's signature", async () => {
  const w = world();
  const token = await webhookVerifyToken(APP.appSecret);
  const check = await handle(new Request(`https://proj.supabase.co/functions/v1/shop-blog/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`), w.deps);
  eq([check.status, await check.text()], [200, "42"], "the challenge");
  eq((await handle(new Request("https://proj.supabase.co/functions/v1/shop-blog/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42"), w.deps)).status, 403, "a wrong token");
  const body = JSON.stringify({ object: "page", entry: [{ id: PAGE, changes: [{ field: "feed", value: { item: "status" } }] }] });
  const bad = await handle(new Request("https://proj.supabase.co/functions/v1/shop-blog/webhook", { method: "POST", headers: { "x-hub-signature-256": "sha256=00" }, body }), w.deps);
  eq(bad.status, 401, "unsigned");
  const good = await handle(new Request("https://proj.supabase.co/functions/v1/shop-blog/webhook", { method: "POST", headers: { "x-hub-signature-256": `sha256=${await hmacHex(APP.appSecret, body)}` }, body }), w.deps);
  eq(good.status, 200, "signed");
  assert(w.log.some((l) => l.startsWith("facebook_sync_page_soon") && l.includes(PAGE)), "that Page syncs soon");
});

Deno.test("IndexNow for posts: each post and the blog page in three languages, on its host", () => {
  eq(blogIndexNowUrls({ host: "davide.sk", kind: "site", at: "", posts: [{ id: "1", shop_slug: "davide", slug: "nova", country: "SK" }] }), [
    "https://davide.sk/blog/nova", "https://davide.sk/blog", "https://davide.sk/hu/blog/nova", "https://davide.sk/hu/blog", "https://davide.sk/en/blog/nova", "https://davide.sk/en/blog",
  ], "own domain: '/' is the shop's language");
  eq(blogIndexNowUrls({ host: "cacaduu.com", kind: "main", at: "", posts: [{ id: "1", shop_slug: "pek", slug: "uj", country: "HU" }] }).slice(0, 2), [
    "https://cacaduu.com/sk/shops/pek/blog/uj", "https://cacaduu.com/sk/shops/pek/blog",
  ], "Cacaduu");
});
