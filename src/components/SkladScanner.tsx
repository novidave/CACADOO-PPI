"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SCAN_CODE, ScanBurst } from "@/lib/sklad";

interface Labels {
  scan: string;
  title: string;
  hint: string;
  close: string;
  torch: string;
  manual: string;
  manual_go: string;
  no_camera: string;
  loading: string;
  found: string;
}

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };

/** A short beep and a vibration when a code is read (both quietly skipped where the device has none). */
function signal() {
  try {
    navigator.vibrate?.(80);
  } catch {}
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1760;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
    osc.onended = () => void ctx.close();
  } catch {}
}

/** The camera's reader: barcode-detector (zxing-wasm; its .wasm from our own /zxing/<version>/), loaded on first use. */
async function makeDetector(): Promise<Detector> {
  const mod = await import("barcode-detector/ponyfill");
  mod.setZXingModuleOverrides({
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? `/zxing/${mod.ZXING_WASM_VERSION}/${path}` : prefix + path),
  });
  return new mod.BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "qr_code"] });
}

/**
 * The scanner on every Sklad page (database update 67):
 * - a USB / Bluetooth scanner works as a keyboard: a burst of keys ≤ 50 ms apart, ≥ 6 characters, ending in Enter, is a
 *   scan (`ScanBurst`); it is ignored inside text fields except the search (`data-scan-ok`), so typing stays typing;
 * - "Skenovať" opens the phone's or tablet's camera (EAN-13, EAN-8, Code128, QR; torch where the device has one; the
 *   code can be typed by hand), with a beep and a vibration;
 * either way the page goes to …/sklad/scan?code=…, which opens the product card or "Nový produkt" with the EAN —
 * unless the page takes the scan itself (Predaj, update 68: it cancels the `sklad:scan` event and fills the basket).
 */
export function SkladScanner({ scanUrl, shop, labels }: { scanUrl: string; shop: string; labels: Labels }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "live" | "none" | "found">("idle");
  const [torch, setTorch] = useState<boolean | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const runRef = useRef(0);

  const go = useCallback(
    (code: string) => {
      const clean = code.trim();
      if (!SCAN_CODE.test(clean)) return;
      // a page that takes scans itself (Predaj: into the basket) cancels the event; else the code opens its card
      const taken = !window.dispatchEvent(new CustomEvent("sklad:scan", { detail: clean, cancelable: true }));
      if (taken) return;
      router.push(`${scanUrl}?${new URLSearchParams({ shop, code: clean })}`);
    },
    [router, scanUrl, shop],
  );

  // the keyboard scanner
  useEffect(() => {
    const burst = new ScanBurst();
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const field = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (field && !el.hasAttribute("data-scan-ok")) {
        burst.reset();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) {
        burst.reset();
        return;
      }
      const code = burst.feed(e.key, e.timeStamp || performance.now());
      if (code) {
        e.preventDefault();
        if (field && el instanceof HTMLInputElement) el.value = el.value.endsWith(code) ? el.value.slice(0, -code.length) : el.value;
        signal();
        go(code);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go]);

  const stop = useCallback(() => {
    runRef.current += 1;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setTorch(null);
  }, []);

  const start = useCallback(async () => {
    const run = ++runRef.current;
    setState("loading");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera");
      const [stream, detector] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }),
        makeDetector(),
      ]);
      if (run !== runRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      await video.play();
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
      setTorch(caps.torch ? false : null);
      setState("live");
      const loop = async () => {
        if (run !== runRef.current) return;
        try {
          if (video.readyState >= 2) {
            const found = await detector.detect(video);
            const code = found.find((f) => SCAN_CODE.test(f.rawValue.trim()))?.rawValue;
            if (code && run === runRef.current) {
              signal();
              setState("found");
              stop();
              dialogRef.current?.close();
              go(code);
              return;
            }
          }
        } catch {}
        window.setTimeout(() => void loop(), 180);
      };
      void loop();
    } catch {
      if (run === runRef.current) setState("none");
    }
  }, [go, stop]);

  useEffect(() => () => stop(), [stop]);

  const openDialog = () => {
    setOpen(true);
    dialogRef.current?.showModal();
    void start();
  };
  const closeDialog = () => {
    stop();
    dialogRef.current?.close();
    setOpen(false);
    setState("idle");
  };
  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {}
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-foreground bg-foreground px-4 text-[15px] font-bold text-white"
        data-sklad-scan
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M17 8v8" />
        </svg>
        {labels.scan}
      </button>
      <dialog
        ref={dialogRef}
        onClose={() => {
          stop();
          setOpen(false);
        }}
        className="m-auto w-[min(100vw-32px,480px)] rounded-2xl border border-line p-0 backdrop:bg-black/60"
        aria-labelledby="sklad-scan-title"
      >
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 id="sklad-scan-title" className="text-lg font-bold">
              {labels.title}
            </h2>
            <button type="button" onClick={closeDialog} className="min-h-11 rounded-xl border border-line px-3 text-sm font-semibold">
              {labels.close}
            </button>
          </div>
          <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-black">
            <video ref={videoRef} muted playsInline className={`size-full object-cover ${open ? "" : "hidden"}`} aria-label={labels.title} />
            {state !== "live" && (
              <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm font-semibold text-white" role="status">
                {state === "none" ? labels.no_camera : state === "found" ? labels.found : labels.loading}
              </p>
            )}
            {state === "live" && <div aria-hidden="true" className="pointer-events-none absolute inset-x-[12%] top-1/2 h-0.5 bg-[#EF4444]" />}
          </div>
          <p className="text-[13px] text-muted">{labels.hint}</p>
          {torch !== null && (
            <button type="button" onClick={() => void toggleTorch()} aria-pressed={torch} className="min-h-11 self-start rounded-xl border border-line px-3 text-sm font-semibold">
              {labels.torch}
            </button>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = String(new FormData(e.currentTarget).get("code") ?? "");
              if (SCAN_CODE.test(v.trim())) {
                closeDialog();
                go(v);
              }
            }}
            className="flex gap-2"
          >
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              {labels.manual}
              <input name="code" inputMode="numeric" autoComplete="off" className="min-h-11 rounded-xl border border-[#D6D6D6] px-3 text-base" />
            </label>
            <button type="submit" className="min-h-11 self-end rounded-xl border border-foreground px-4 text-sm font-bold">
              {labels.manual_go}
            </button>
          </form>
        </div>
      </dialog>
    </>
  );
}
