"use client";

import { useEffect, useRef, useState } from "react";
import { PendingButton } from "@/components/PendingButton";
import { nameMatches, type InventoryPreview } from "@/lib/inventoryReset";

type Labels = Record<string, string>;
type Action = (formData: FormData) => void | Promise<void>;

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/** The hidden fields every form of the page sends (lang, shop id and slug). */
function Hidden({ fields }: { fields: Record<string, string> }) {
  return (
    <>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

/** A button that opens a confirmation dialog (Esc or "Zrušiť" closes it; nothing happens until the form is sent). */
function Confirm({
  button,
  title,
  children,
  testId,
  disabled = false,
}: {
  button: string;
  title: string;
  children: (close: () => void) => React.ReactNode;
  testId: string;
  disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  // The dialog follows `open` (opened with its button, closed with "Zrušiť", Esc or after sending).
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  const close = () => setOpen(false);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:border-line disabled:text-muted"
        data-open={testId}
      >
        {button}
      </button>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        aria-labelledby={`${testId}-title`}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] border border-foreground bg-background p-0 text-foreground backdrop:bg-black/40"
        data-dialog={testId}
      >
        <div className="flex flex-col gap-3 p-4">
          <h3 id={`${testId}-title`} className="text-lg font-semibold">
            {title}
          </h3>
          {open && children(close)}
        </div>
      </dialog>
    </>
  );
}

function Buttons({ labels, confirm, close, enabled = true }: { labels: Labels; confirm: string; close: () => void; enabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {enabled ? (
        <PendingButton pending={labels.working}>{confirm}</PendingButton>
      ) : (
        <button type="submit" disabled className="self-start rounded border border-line px-4 py-2 font-medium text-muted">
          {confirm}
        </button>
      )}
      <button type="button" onClick={close} className="self-start rounded border border-line px-4 py-2">
        {labels.cancel}
      </button>
    </div>
  );
}

/** 2b — "Vymazať všetky nahrané súbory" in "Posledné nahrané súbory": the inventory stays. */
export function DeleteFilesButton({ files, hidden, labels, action }: { files: number; hidden: Record<string, string>; labels: Labels; action: Action }) {
  return (
    <Confirm button={labels.files_button} title={labels.files_confirm_title} testId="delete-files" disabled={files === 0}>
      {(close) => (
        <form action={action} className="flex flex-col gap-3">
          <Hidden fields={hidden} />
          <p>{fill(labels.files_confirm_text, { n: files })}</p>
          <p className="text-sm text-muted">{labels.files_confirm_more}</p>
          <Buttons labels={labels} confirm={labels.files_delete} close={close} />
        </form>
      )}
    </Confirm>
  );
}

/** Options A and B of "Nebezpečná zóna – sklad", each behind its dialog with the counts. */
export function InventoryResetOptions({
  preview,
  hidden,
  labels,
  action,
}: {
  preview: InventoryPreview;
  hidden: Record<string, string>;
  labels: Labels;
  action: Action;
}) {
  const noResets = preview.resets_left <= 0;
  const shown = preview.missing_list.slice(0, 20);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm" data-resets-left>
        {noResets ? labels.limit_none : fill(labels.limit_left, { n: preview.resets_left })}
      </p>

      <section className="flex flex-col gap-2 border border-line p-3" data-reset-option="missing">
        <h3 className="font-semibold">{labels.a_title}</h3>
        <p className="text-sm font-semibold">{labels.a_recommended}</p>
        <p className="text-sm">{labels.a_text}</p>
        {preview.missing > 0 ? (
          <>
            <p className="text-sm" data-missing-count={preview.missing}>
              {fill(labels.a_count, { n: preview.missing })}
            </p>
            <ul className="list-disc pl-6 text-sm" data-missing-list>
              {shown.map((m) => (
                <li key={m.code}>
                  {m.name} <span className="text-muted">({m.code})</span>
                </li>
              ))}
              {preview.missing > shown.length && <li className="list-none text-muted">{fill(labels.a_more, { n: preview.missing - shown.length })}</li>}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted">{labels.a_none}</p>
        )}
        <Confirm button={labels.a_button} title={labels.a_confirm_title} testId="reset-missing" disabled={preview.missing === 0 || noResets}>
          {(close) => (
            <form action={action} className="flex flex-col gap-3">
              <Hidden fields={{ ...hidden, mode: "missing" }} />
              <p className="font-semibold">{fill(labels.a_confirm_counts, { n: preview.missing })}</p>
              <p className="text-sm">{labels.confirm_backup}</p>
              <Buttons labels={labels} confirm={labels.confirm_remove} close={close} />
            </form>
          )}
        </Confirm>
      </section>

      <section className="flex flex-col gap-2 border border-line p-3" data-reset-option="all">
        <h3 className="font-semibold">{labels.b_title}</h3>
        <p className="text-sm">{labels.b_text}</p>
        <Confirm
          button={labels.b_button}
          title={labels.b_confirm_title}
          testId="reset-all"
          disabled={noResets || (preview.items === 0 && preview.files === 0)}
        >
          {(close) => <ResetAllForm preview={preview} hidden={hidden} labels={labels} action={action} close={close} />}
        </Confirm>
      </section>
    </div>
  );
}

/** Option B's dialog: the choices and the shop's name typed to confirm (fresh each time the dialog opens). */
function ResetAllForm({
  preview,
  hidden,
  labels,
  action,
  close,
}: {
  preview: InventoryPreview;
  hidden: Record<string, string>;
  labels: Labels;
  action: Action;
  close: () => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <form action={action} className="flex flex-col gap-3">
      <Hidden fields={{ ...hidden, mode: "all" }} />
      <p className="font-semibold">{fill(labels.b_confirm_counts, { items: preview.items, files: preview.files })}</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="keep_translations" defaultChecked className="mt-1" data-keep-translations />
        <span>{labels.b_keep}</span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="clear_mapping" className="mt-1" data-clear-mapping />
        <span>{labels.b_mapping}</span>
      </label>
      <p className="text-sm">{labels.confirm_backup}</p>
      <p className="text-sm text-muted">{labels.b_folder_note}</p>
      <label className="flex flex-col gap-1 text-sm">
        <span>{fill(labels.b_confirm_type, { name: preview.shop_name })}</span>
        <input
          name="confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          aria-label={labels.b_confirm_field}
          className="rounded border border-line px-3 py-2 outline-none focus:border-foreground"
          data-confirm-name
        />
      </label>
      <Buttons labels={labels} confirm={labels.confirm_reset} close={close} enabled={nameMatches(typed, preview.shop_name)} />
    </form>
  );
}

/**
 * After A or B: the backup CSV the database made first is downloaded once (the address carries ?backup=<id>), with a
 * link in case the browser did not start it.
 */
export function BackupDownload({ href, label, link }: { href: string; label: string; link: string }) {
  useEffect(() => {
    const key = `ppi.backup.${href}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // storage blocked: still download once per page load
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [href]);
  return (
    <p className="border border-line p-3 text-sm" data-backup-download>
      {label}{" "}
      <a href={href} download className="underline underline-offset-4">
        {link}
      </a>
    </p>
  );
}
