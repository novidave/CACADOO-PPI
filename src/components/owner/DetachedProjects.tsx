"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { functionFailure } from "@/lib/functionError";
import { createClient } from "@/lib/supabase/client";
import { cardClass, ghostClass } from "@/components/owner/ui";

export interface DetachedProject {
  id: string;
  forgotten_at: string | null;
  forgotten_reason: "forget_all" | "contact_deleted" | null;
  created_at: string;
  files: number;
  bytes: number;
}

/**
 * CRM → Kontakty (update 95): projects whose contact is gone — the customer's "Vymazať moje údaje" or the owner's
 * delete. Switched off, nobody can open them; the files stay until the owner removes them here (after a confirmation:
 * doc-ingest deletes every stored file first, then the project).
 */
export function DetachedProjects({ projects, lang, labels }: { projects: DetachedProject[]; lang: string; labels: Dictionary["project"] }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(iso)) : "–");

  async function purge(id: string) {
    setConfirm(null);
    const { error } = await createClient().functions.invoke("doc-ingest", { body: { action: "project_purge", project_id: id } });
    if (error) {
      const failure = await functionFailure(error);
      setMessage(labels.error.replace("{message}", failure.error ?? failure.detail));
      return;
    }
    router.refresh();
  }

  return (
    <section className={cardClass} data-detached-projects>
      <h2 className="text-base font-semibold">{labels.detached_title}</h2>
      <ul className="flex flex-col divide-y divide-line text-sm">
        {projects.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 py-2" data-detached-project={p.id}>
            <span className="font-medium">{p.forgotten_reason === "forget_all" ? labels.detached_forget_all : labels.detached_deleted}</span>
            <span className="text-muted">{labels.detached_line.replace("{when}", when(p.forgotten_at)).replace("{n}", String(p.files))}</span>
            {confirm === p.id ? (
              <div className="flex flex-col gap-2 rounded-xl border border-line p-3" role="alertdialog">
                <p>{labels.detached_confirm}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void purge(p.id)} className={ghostClass}>{labels.confirm_yes}</button>
                  <button type="button" onClick={() => setConfirm(null)} className={ghostClass}>{labels.cancel}</button>
                </div>
              </div>
            ) : (
              <div>
                <button type="button" onClick={() => setConfirm(p.id)} className={ghostClass}>{labels.detached_remove}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {message && <p role="alert" className="text-sm text-[#B91C1C]">{message}</p>}
    </section>
  );
}
