"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { facebookPages, pickFacebookPage } from "@/app/[lang]/(account)/dashboard/blog/actions";

/**
 * After Facebook's login: the Pages the owner runs (names and pictures; the tokens stay in the function), one to pick.
 * Then the page reloads without ?fb_pick (the editor reopens its publish dialog when it came from there).
 */
export function FacebookPagePicker({
  pendingId,
  doneUrl,
  labels,
}: {
  pendingId: string;
  /** Where to go once a Page is connected. */
  doneUrl: string;
  labels: { fb_pick_title: string; fb_pick_button: string; fb_pick_expired: string; fb_profiles: string; error_failed: string; saving: string };
}) {
  const router = useRouter();
  const [pages, setPages] = useState<{ id: string; name: string; picture: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void facebookPages({ pendingId }).then((r) => {
      if (!live) return;
      if (r.error) setError(r.error === "fb_pick_expired" ? labels.fb_pick_expired : labels.error_failed.replace("{message}", r.error));
      else setPages(r.pages ?? []);
    });
    return () => {
      live = false;
    };
  }, [pendingId, labels]);

  const pick = async (id: string) => {
    setBusy(id);
    const r = await pickFacebookPage({ pendingId, pageId: id });
    if (r.error) {
      setBusy(null);
      setError(r.error === "fb_pick_expired" ? labels.fb_pick_expired : labels.error_failed.replace("{message}", r.error));
      return;
    }
    router.replace(doneUrl);
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-3 border border-foreground p-4" aria-labelledby="fb-pick-title" data-facebook-picker>
      <h2 id="fb-pick-title" className="font-semibold">
        {labels.fb_pick_title}
      </h2>
      <p className="text-sm text-muted">{labels.fb_profiles}</p>
      {error && <p role="alert" className="border border-line p-3 text-sm">{error}</p>}
      {pages && (
        <ul className="flex flex-col gap-2">
          {pages.map((p) => (
            <li key={p.id} className="flex items-center gap-3">
              {p.picture ? (
                // eslint-disable-next-line @next/next/no-img-element -- the Page's picture from Facebook, in Môj obchod only
                <img src={p.picture} alt="" width={40} height={40} className="h-10 w-10 rounded-full border border-line object-cover" />
              ) : (
                <span className="h-10 w-10 rounded-full border border-line" aria-hidden />
              )}
              <span className="flex-1 font-medium">{p.name}</span>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void pick(p.id)}
                className="rounded border border-foreground px-3 py-1.5 font-medium disabled:text-muted"
                data-pick-page={p.id}
              >
                {busy === p.id ? labels.saving : labels.fb_pick_button}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
