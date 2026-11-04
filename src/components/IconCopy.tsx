"use client";

import { useEffect, useRef, useState } from "react";

/**
 * An icon-only copy button (the unified design, 2026-11-04): the product's name, the post's address, or the product's
 * photo (as PNG through ClipboardItem — the only picture type browsers copy). After copying an orange check for 2 s;
 * a refusal (no clipboard, a blocked permission, a browser without image copying) is said in the aria-live line.
 */
export function IconCopy({
  kind,
  value,
  label,
  done,
  refused,
  className = "",
}: {
  kind: "text" | "image";
  /** The text, or the picture's address (same site or CORS). */
  value: string;
  label: string;
  done: string;
  refused: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [said, setSaid] = useState("");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const ok = () => {
    setCopied(true);
    setSaid(done);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setCopied(false);
      setSaid("");
    }, 2000);
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // older browsers: a hidden field, selected and copied
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      const done = document.execCommand?.("copy") ?? false;
      field.remove();
      return done;
    }
  };

  const copyImage = async () => {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
    // the PNG is made inside the click (Safari wants the item at once, with a promise of its data)
    const png = (async () => {
      const res = await fetch(value, { mode: "cors" });
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      bitmap.close();
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png"));
    })();
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return true;
    } catch {
      return false;
    }
  };

  return (
    <>
      <button
        type="button"
        className={`ppi-u-copy ${className}`}
        aria-label={label}
        title={label}
        onClick={async () => {
          const success = kind === "image" ? await copyImage() : await copyText();
          if (success) ok();
          else setSaid(refused);
        }}
        {...(copied ? { "data-copied": "" } : {})}
        data-copy={kind}
      >
        {copied ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="9" y="9" width="11" height="11" rx="2.5" />
            <path d="M15 9V6.5A2.5 2.5 0 0012.5 4h-6A2.5 2.5 0 004 6.5v6A2.5 2.5 0 006.5 15H9" />
          </svg>
        )}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
    </>
  );
}
