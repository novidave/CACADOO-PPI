"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { facebookMessage } from "@/lib/blogFormat";
import { drawBlogPhoto } from "@/lib/blogPhotos";
import { functionFailure } from "@/lib/functionError";
import { createClient } from "@/lib/supabase/client";
import {
  facebookLoginUrl,
  postToFacebook,
  publishBlogPost,
  saveBlogPost,
  setBlogChoice,
  setBlogPhotoOrder,
} from "@/app/[lang]/(account)/dashboard/blog/actions";
import { PublishDialog, type FacebookState } from "./PublishDialog";

type Labels = Dictionary["owner_blog"];

export interface EditorPost {
  id: string;
  slug: string;
  title: string;
  body: string;
  source: "cacaduu" | "facebook";
  status: "draft" | "published" | "hidden" | "pending";
  publish_at: string | null;
  fb_choice: "web" | "web_fb" | null;
  fb_status: "waiting" | "posting" | "posted" | "failed" | null;
  fb_error: string | null;
  fb_permalink: string | null;
  photos: { id: string; src: string; kind: "photo" | "video" }[];
}

interface Result {
  scheduled: boolean;
  publishAt: string;
  facebook: "none" | "sending" | "ok" | "error" | "later";
  permalink: string | null;
  fbError: string | null;
}

/**
 * "Nový článok" / "Upraviť článok" in Môj obchod → Novinky / Blog: the title and text exactly as written, up to 10
 * photos (drawn 1600 / 800 px in this browser, sent to the shop-blog function, which checks them), now or at a time.
 * Before "Zverejniť" / "Naplánovať" the publish dialog asks about Facebook every time (only when Facebook is set up on
 * Cacaduu); a live post's edits never go to Facebook ("Zmena sa prejaví len na webe, nie na Facebooku.").
 */
export function BlogEditor({
  lang,
  shopId,
  shopSlug,
  timeZone,
  post,
  facebook,
  lastChoice,
  postUrl,
  viewPath,
  defaultAt,
  resume,
  now,
  labels,
}: {
  lang: string;
  shopId: string;
  shopSlug: string;
  timeZone: string;
  post: EditorPost | null;
  facebook: { enabled: boolean; state: FacebookState; page: { name: string; picture: string | null } | null };
  lastChoice: "web" | "web_fb" | null;
  /** The post's canonical address without its slug ("https://davide.sk/blog/"). */
  postUrl: string;
  /** Its page on the address this owner is on, without the slug. */
  viewPath: string;
  /** The scheduled time field's first value (tomorrow 08:00 in the shop's time zone). */
  defaultAt: string;
  resume: { publish: boolean; at: string | null };
  /** When the page was made (the server's clock): whether the post is live or still scheduled. */
  now: number;
  labels: Labels;
}) {
  const router = useRouter();
  const [postId, setPostId] = useState(post?.id ?? null);
  const [slug, setSlug] = useState(post?.slug ?? "");
  const [title, setTitle] = useState(post?.title ?? "");
  const [body, setBody] = useState(post?.body ?? "");
  const [photos, setPhotos] = useState(post?.photos ?? []);
  const [when, setWhen] = useState<"now" | "later">(resume.at ? "later" : "now");
  const [at, setAt] = useState(resume.at ?? defaultAt);
  // Back from Facebook's login (the Page picked): the dialog opens again.
  const [dialog, setDialog] = useState(
    resume.publish && Boolean(post?.id) && facebook.enabled && post?.source !== "facebook" && (post?.status === "draft" || post?.status === "published"),
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [choice, setChoice] = useState(post?.fb_choice ?? null);
  const fileInput = useRef<HTMLInputElement>(null);

  const imported = post?.source === "facebook";
  const live = Boolean(post && post.status === "published" && post.publish_at && Date.parse(post.publish_at) <= now);
  const scheduled = Boolean(post && post.status === "published" && post.publish_at && Date.parse(post.publish_at) > now);
  const canPublish = !imported && !result && (!post || post.status === "draft" || scheduled);
  const onFacebook = imported || post?.fb_status === "posted";
  const shown = (iso: string) => new Intl.DateTimeFormat(lang, { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const choiceLabel = (c: "web" | "web_fb" | null) => (c === "web_fb" ? labels.choice_web_fb : labels.choice_web);

  const errorText = (code: string | undefined) => {
    if (!code) return labels.error_failed.replace("{message}", "?");
    if (code.startsWith("failed:")) return labels.error_failed.replace("{message}", code.slice(7));
    return (labels as Record<string, string>)[`error_${code}`] ?? labels.error_failed.replace("{message}", code);
  };

  /** Saves the title and text; returns the post's id (a new draft the first time). */
  const save = async (): Promise<string | null> => {
    const r = await saveBlogPost({ shopId, postId, title, body: imported ? "" : body });
    if (r.error || !r.id) {
      setError(errorText(r.error));
      return null;
    }
    if (r.slug) setSlug(r.slug);
    // The address stays (/new): changing it would make the next refresh another page and lose this editor's state.
    // Facebook's login comes back to /<id>; the list shows the draft.
    if (r.id !== postId) setPostId(r.id);
    return r.id;
  };

  const invoke = async <T,>(name: string, payload: unknown, headers?: Record<string, string>): Promise<T> => {
    const { data, error: failed } = await createClient().functions.invoke<T>(name, { body: payload as never, headers, method: "POST" });
    if (!failed) return data as T;
    const f = await functionFailure(failed);
    throw new Error(f.error ?? f.detail);
  };

  const addPhotos = async (files: File[]) => {
    setError(null);
    setMessage(null);
    if (!title.trim()) {
      setError(labels.error_title);
      return;
    }
    const room = 10 - photos.filter((p) => p.kind === "photo").length;
    if (room <= 0) {
      setError(labels.photo_limit);
      return;
    }
    setBusy(true);
    try {
      const id = await save();
      if (!id) return;
      const list = files.slice(0, room);
      for (let i = 0; i < list.length; i++) {
        setProgress(labels.photos_uploading.replace("{n}", String(i + 1)).replace("{total}", String(list.length)));
        let drawn;
        try {
          drawn = await drawBlogPhoto(list[i]);
        } catch {
          setError(labels.photo_error.replace("{name}", list[i].name));
          continue;
        }
        const begun = await invoke<{ photo_id: string }>("shop-blog", { action: "photo_begin", post_id: id });
        const send = (size: number, blob: Blob) =>
          invoke(`shop-blog?action=photo&photo_id=${begun.photo_id}&size=${size}`, blob, { "Content-Type": blob.type });
        await send(1600, drawn.large);
        if (drawn.small) await send(800, drawn.small);
        setPhotos((now) => [...now, { id: begun.photo_id, src: URL.createObjectURL(drawn.small ?? drawn.large), kind: "photo" }]);
      }
      if (files.length > room) setError(labels.photo_limit);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(m === "photo_limit" ? labels.photo_limit : m === "picture" ? labels.photo_error.replace("{name}", "") : errorText(`failed:${m}`));
    } finally {
      setBusy(false);
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const removePhoto = async (photoId: string) => {
    setBusy(true);
    try {
      await invoke("shop-blog", { action: "photo_delete", photo_id: photoId });
      setPhotos((now) => now.filter((p) => p.id !== photoId));
    } catch (e) {
      setError(errorText(`failed:${e instanceof Error ? e.message : e}`));
    } finally {
      setBusy(false);
    }
  };

  const movePhoto = async (index: number) => {
    if (!postId || index < 1) return;
    const next = [...photos];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setPhotos(next);
    const r = await setBlogPhotoOrder({ postId, ids: next.map((p) => p.id) });
    if (r.error) setError(errorText(r.error));
  };

  const onSave = async () => {
    setError(null);
    setBusy(true);
    const id = await save();
    setBusy(false);
    if (id) {
      setMessage(labels.saved);
      router.refresh();
    }
  };

  /** "Zverejniť" / "Naplánovať": saved first, then the dialog (or straight to the web when Facebook is not set up). */
  const onPublish = async () => {
    setError(null);
    setMessage(null);
    if (!title.trim()) {
      setError(labels.error_title);
      return;
    }
    setBusy(true);
    const id = await save();
    setBusy(false);
    if (!id) return;
    if (facebook.enabled) setDialog(true);
    else await publish(id, "web");
  };

  const sendToFacebook = async (id: string, retry: boolean) => {
    setResult((r) => (r ? { ...r, facebook: "sending", fbError: null } : r));
    const fb = await postToFacebook({ postId: id, retry });
    setResult((r) =>
      r ? { ...r, facebook: fb.ok ? "ok" : "error", permalink: fb.permalink ?? null, fbError: fb.ok ? null : fb.error === "published" ? labels.fb_posted : (fb.error ?? "") } : r,
    );
  };

  const publish = async (id: string, picked: "web" | "web_fb") => {
    setBusy(true);
    const r = await publishBlogPost({ postId: id, at: when === "later" ? at : null, timeZone, choice: picked });
    setBusy(false);
    setDialog(false);
    if (r.error || !r.publishAt) {
      setError(errorText(r.error));
      return;
    }
    setChoice(picked);
    setResult({
      scheduled: Boolean(r.scheduled),
      publishAt: r.publishAt,
      facebook: picked === "web_fb" ? (r.facebookNow ? "sending" : "later") : "none",
      permalink: null,
      fbError: null,
    });
    if (r.facebookNow) await sendToFacebook(id, false);
    router.refresh();
  };

  const connect = async () => {
    setBusy(true);
    const id = postId ?? (await save());
    if (!id) {
      setBusy(false);
      return;
    }
    const back = `/${lang}/dashboard/blog/${id}?${new URLSearchParams({ shop: shopSlug, resume: "publish", ...(when === "later" ? { at } : {}) })}`;
    const r = await facebookLoginUrl({ shopId, returnPath: back });
    if (r.url) {
      window.location.href = r.url;
      return;
    }
    setBusy(false);
    setDialog(false);
    setError(errorText(r.error === "not_configured" ? "fb_not_configured" : r.error));
  };

  const changeChoice = async (next: "web" | "web_fb") => {
    if (!postId) return;
    setBusy(true);
    const r = await setBlogChoice({ postId, choice: next });
    setBusy(false);
    if (r.error) setError(errorText(r.error));
    else {
      setChoice(next);
      router.refresh();
    }
  };

  const url = `${postUrl}${slug || "…"}`;
  const fbPhotos = photos.filter((p) => p.kind === "photo").map((p) => p.src);
  const whenShown = when === "later" && at ? at.replace("T", " ") : null;
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

  return (
    <div className="flex flex-col gap-5" data-blog-editor>
      {imported && <p className="border border-line p-3 text-sm">{labels.imported_note}</p>}
      {post && scheduled && !result && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-line p-3 text-sm" data-scheduled>
          <span>{labels.scheduled_for.replace("{date}", shown(post.publish_at!)).replace("{choice}", choiceLabel(choice))}</span>
          {facebook.enabled && (choice === "web_fb" || facebook.state === "connected") && (
            <button type="button" disabled={busy} className="underline underline-offset-4" onClick={() => void changeChoice(choice === "web_fb" ? "web" : "web_fb")}>
              {labels.change_choice.replace("{choice}", choiceLabel(choice === "web_fb" ? "web" : "web_fb"))}
            </button>
          )}
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.title_label}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required className={input} name="title" />
      </label>

      {imported ? (
        <div className="flex flex-col gap-1">
          <span className="text-sm">{labels.body_label}</span>
          <p className="whitespace-pre-wrap break-words border border-line p-3 text-sm">{body}</p>
        </div>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-sm">{labels.body_label}</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} maxLength={70000} className={input} name="body" />
          <span className="text-sm text-muted">{labels.body_hint}</span>
        </label>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-sm">{labels.photos_label}</span>
        {photos.length > 0 && (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-editor-photos>
            {photos.map((p, i) => (
              <li key={p.id} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- the owner's own photo (800 px copy) */}
                <img src={p.src} alt="" className="aspect-square h-auto w-full border border-line object-cover" />
                {!imported && (
                  <span className="flex flex-wrap gap-x-2 text-xs">
                    {i > 0 && (
                      <button type="button" disabled={busy} className="underline underline-offset-2" onClick={() => void movePhoto(i)} aria-label={labels.photo_move_left}>
                        ←
                      </button>
                    )}
                    <button type="button" disabled={busy} className="underline underline-offset-2" onClick={() => void removePhoto(p.id)}>
                      {labels.photo_remove}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {!imported && photos.length < 10 && (
          <label className="flex flex-col gap-1">
            <span className="cursor-pointer self-start font-medium underline underline-offset-4">{labels.photos_pick}</span>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              multiple
              disabled={busy}
              className="sr-only"
              onChange={(e) => void addPhotos([...(e.target.files ?? [])])}
              data-photo-input
            />
          </label>
        )}
        {!imported && <span className="text-sm text-muted">{labels.photos_note}</span>}
      </div>

      {canPublish && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm">{labels.when_label}</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="when" checked={when === "now"} onChange={() => setWhen("now")} /> {labels.when_now}
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <input type="radio" name="when" checked={when === "later"} onChange={() => setWhen("later")} /> {labels.when_later}
            <input
              type="datetime-local"
              value={at}
              onChange={(e) => {
                setAt(e.target.value);
                setWhen("later");
              }}
              className={input}
              aria-label={labels.when_later}
            />
          </label>
          <span className="text-sm text-muted">{labels.when_hint.replace("{zone}", timeZone)}</span>
        </fieldset>
      )}

      {live && facebook.enabled && onFacebook && <p className="text-sm font-medium" data-edit-note>{labels.edit_note}</p>}
      {progress && <p role="status" aria-live="polite" className="text-sm">{progress}</p>}
      {error && <p role="alert" className="border border-line p-3 text-sm">{error}</p>}
      {message && <p role="status" className="border border-foreground p-3 text-sm font-medium">{message}</p>}

      {result && (
        <div role="status" aria-live="polite" className="flex flex-col gap-2 border border-foreground p-3" data-publish-result>
          <p className="font-medium">{result.scheduled ? labels.done_scheduled.replace("{date}", shown(result.publishAt)) : labels.done_web}</p>
          {!result.scheduled && slug && (
            <a href={`${viewPath}${slug}`} className="self-start text-sm underline underline-offset-4" target="_blank" rel="noopener">
              {labels.view}
            </a>
          )}
          {result.facebook === "later" && <p className="text-sm">{labels.dialog_scheduled.replace("{date}", shown(result.publishAt))}</p>}
          {result.facebook === "sending" && <p className="text-sm">{labels.sending_fb}</p>}
          {result.facebook === "ok" && (
            <p className="flex flex-wrap items-center gap-x-3 text-sm font-medium" data-fb-ok>
              {labels.done_fb}
              {result.permalink && (
                <a href={result.permalink} target="_blank" rel="noopener" className="font-normal underline underline-offset-4">
                  {labels.open_fb}
                </a>
              )}
            </p>
          )}
          {result.facebook === "error" && (
            <div className="flex flex-col gap-2" data-fb-error>
              <p className="text-sm">{labels.fb_error.replace("{message}", result.fbError ?? "")}</p>
              <button type="button" className="self-start rounded border border-foreground px-4 py-2 font-medium" onClick={() => postId && void sendToFacebook(postId, true)}>
                {labels.retry_fb}
              </button>
            </div>
          )}
        </div>
      )}

      {!result && (
        <div className="flex flex-wrap gap-2">
          {canPublish ? (
            <>
              <button type="button" disabled={busy} onClick={() => void onPublish()} className="rounded border border-foreground bg-foreground px-4 py-2 font-medium text-white disabled:opacity-60" data-publish>
                {when === "later" ? labels.schedule : labels.publish}
              </button>
              <button type="button" disabled={busy} onClick={() => void onSave()} className="rounded border border-foreground px-4 py-2 font-medium disabled:text-muted" data-save>
                {post && post.status !== "draft" ? labels.save : labels.save_draft}
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => void onSave()} className="rounded border border-foreground px-4 py-2 font-medium disabled:text-muted" data-save>
              {labels.save}
            </button>
          )}
        </div>
      )}

      {facebook.enabled && (
        <PublishDialog
          open={dialog}
          state={facebook.state}
          page={facebook.page}
          message={facebookMessage(title, body, url)}
          photos={fbPhotos}
          when={whenShown}
          preselect={lastChoice ?? (facebook.state === "connected" ? "web_fb" : "web")}
          busy={busy}
          labels={labels}
          onChoose={(c) => postId && void publish(postId, c)}
          onConnect={() => void connect()}
          onBack={() => setDialog(false)}
        />
      )}
    </div>
  );
}
