"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Finishes a login whose tokens arrived after "#" in the address (Supabase's
 * default invite e-mail). The server never sees that part, so the browser
 * stores the session itself, then continues to `next`.
 */
export function FinishLogin({ next, lang, labels }: { next: string; lang: string; labels: { working: string; failed: string } }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    // Remove the tokens from the address bar and browser history right away.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);

    async function finish() {
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      if (!access_token || !refresh_token || params.get("error")) return false;
      const { error } = await createClient().auth.setSession({ access_token, refresh_token });
      return !error;
    }
    finish()
      .catch(() => false)
      .then((ok) => (ok ? window.location.replace(next) : setFailed(true)));
  }, [next]);

  return failed ? (
    <p className="border border-line p-3">
      {labels.failed}{" "}
      <a href={`/${lang}/login`} className="underline underline-offset-4">
        →
      </a>
    </p>
  ) : (
    <p className="text-muted">{labels.working}</p>
  );
}
