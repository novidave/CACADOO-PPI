"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const EXTENSIONS = ["xml", "csv", "tsv", "txt", "gz"];

/**
 * A partner's feed file (admin page, "Partnerské feedy"): straight from the admin's browser to the
 * private bucket partner-feeds — a feed can be far larger than a request to the website may be —
 * then registerPartnerFile() makes it the partner's feed and starts the import. The storage policy and
 * admin_set_partner_file() both check is_admin().
 */
export function PartnerFileUpload({
  partnerId,
  kind,
  label,
  labels,
  register,
}: {
  partnerId: string;
  kind: "products" | "inventory";
  label: string;
  labels: { uploading: string; failed: string; errors: Record<string, string> };
  register: (partnerId: string, kind: "products" | "inventory", path: string) => Promise<string | null>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function upload(file: File) {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!EXTENSIONS.includes(ext)) {
      setMessage(labels.errors.partner_file ?? labels.failed);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const path = `${partnerId}/${kind === "products" ? "feed" : "inventory"}-${Date.now()}.${ext}`;
      const { error } = await createClient().storage.from("partner-feeds").upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (error) {
        setMessage(labels.failed.replace("{message}", error.message));
        return;
      }
      const code = await register(partnerId, kind, path);
      if (code && code !== "partner_function") setMessage(labels.errors[code] ?? labels.failed.replace("{message}", code));
      else if (code) setMessage(labels.errors.partner_function ?? code);
      router.refresh();
    } catch (e) {
      setMessage(labels.failed.replace("{message}", e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 text-sm" data-partner-upload={kind}>
      <label className="flex flex-col gap-1">
        <span>{label}</span>
        <input
          type="file"
          accept=".xml,.csv,.tsv,.txt,.gz"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = "";
          }}
          className="text-sm"
        />
      </label>
      {busy && <span className="text-muted">{labels.uploading}</span>}
      {message && (
        <span role="alert" className="font-semibold">
          {message}
        </span>
      )}
    </div>
  );
}
