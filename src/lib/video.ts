/**
 * Videos in the blog and the slider (database update 39). A Facebook video or reel stays on Facebook (its picture
 * and a link); a YouTube video plays on the blog post only after a tap (youtube-nocookie, nothing loads before). Where
 * the slider's ▶ leads is the owner's choice ("Tlačidlo ▶ pri videách otvorí"). Shared by the server, the browser
 * and the tests (no imports).
 */

export type VideoTarget = "post" | "facebook";

/** A post's video as blog_post_video() gives it. */
export interface PostVideo {
  kind: "youtube" | "facebook";
  youtube_id: string | null;
  link: string | null;
  /** The post's own address on Facebook (null for a post written only in Cacaduu). */
  facebook_url: string | null;
}

/**
 * The 11-character id of a YouTube video address (watch, youtu.be, shorts, embed, live; www., m., music.), else null.
 * The same rule as public.youtube_id() and youtubeId() in the shop-blog function.
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
      else id = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname)?.[2] ?? null;
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export const youtubeWatch = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** The player after a tap: youtube-nocookie (no YouTube cookies until the video plays), started at once. */
export const youtubeEmbed = (id: string) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`;

/** A Facebook address (facebook.com, its subdomains, fb.watch, fb.com), https only. */
export function isFacebookUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)(facebook\.com|fb\.com|fb\.watch)$/.test(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Where the slider's ▶ leads: "facebook" = the post on Facebook (on a phone with the Facebook app, the phone opens it
 * there), else — and for a post that is not on Facebook — the article on Cacaduu, at its video (#video).
 */
export function videoHref(video: PostVideo, target: VideoTarget, postHref: string): { href: string; external: boolean } {
  if (target === "facebook") {
    const fb = [video.facebook_url, video.kind === "facebook" ? video.link : null].find(isFacebookUrl);
    if (fb) return { href: fb, external: true };
  }
  return { href: `${postHref}#video`, external: false };
}

/** A video post's ▶ in the slider: where it leads and whether that is Facebook (null: not a video post). */
export function videoSlide(video: PostVideo | null | undefined, target: VideoTarget, postHref: string) {
  if (!video) return null;
  const to = videoHref(video, target, postHref);
  return { ...to, facebook: to.external };
}
